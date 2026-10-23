// Rewrites a pre-v0.24 export body onto the ent frame.

import { cmpBytes } from "../../shared/checksum.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { eidCodec, makeEID } from "../../shared/codecs/eid.ts";
import { encodeEnt, entCodec } from "../../shared/codecs/ent.ts";
import type { IKDM } from "../../shared/codecs/kdm.ts";
import { Status } from "../../shared/consts.ts";
import type {
  EntityID,
  IMessageHead,
  IMsgEntBody,
} from "../../shared/types.ts";
import { err, ok, ValStat } from "../../shared/valstat.ts";

// encode/decode for the old msgpack body and for the application tail.
export interface MsgPack {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

export interface ExportMsg {
  head: IMessageHead;
  body?: Uint8Array;
  realm?: IKDM;
}

const kept = new Set(["body", "pid", "tags", "type"]);
const empty = new Uint8Array(0);

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    !(v instanceof Uint8Array);
}

// Old bodies are msgpack maps. An ent frame starts with a small var-int.
function isMsgpackMap(b: Uint8Array): boolean {
  const x = b[0];
  if (x === undefined) return false;
  return (x >= 0x80 && x <= 0x8f) || x === 0xde || x === 0xdf;
}

function tagsOf(v: unknown): ValStat<string[] | undefined> {
  if (v === undefined || v === null) return ok(undefined);
  if (!Array.isArray(v)) return err(Status.InvalidMessage);
  const tags: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") return err(Status.InvalidMessage);
    tags.push(t);
  }
  return ok(tags);
}

// pid is the raw eid bytes. Re-encode so the brand matches makeEID.
function pidOf(v: unknown): ValStat<EntityID | undefined> {
  if (v === undefined || v === null) return ok(undefined);
  if (!(v instanceof Uint8Array) || v.length === 0) {
    return err(Status.InvalidMessage);
  }
  const dec = new Decoder(v);
  const [parsed, st] = dec.readStruct(eidCodec);
  if (st !== Status.Success) return err(st);
  if (!dec.done()) return err(Status.InvalidMessage);
  return makeEID(parsed);
}

function nok<T>(st: Status): ValStat<T> {
  if (st === Status.Success) return err(Status.InternalError);
  return err(st);
}

interface OldEnt {
  pid?: EntityID;
  tags?: string[];
  type?: string;
  pay: Uint8Array;
}

// Reads a pre-v0.24 map. Null gid, pid, and tags are absent.
// A gid with any other value rejects the message.
function readOld(v: unknown, pack: MsgPack): ValStat<OldEnt> {
  if (!isMap(v)) return nok(Status.InvalidMessage);
  for (const k of Object.keys(v)) {
    if (kept.has(k)) continue;
    if (k === "gid" && v.gid === null) continue;
    return nok(Status.InvalidMessage);
  }
  const [pid, stPid] = pidOf(v.pid);
  if (stPid !== Status.Success) return nok(stPid);
  const [tags, stTags] = tagsOf(v.tags);
  if (stTags !== Status.Success) return nok(stTags);
  if (v.type !== undefined && v.type !== null && typeof v.type !== "string") {
    return nok(Status.InvalidMessage);
  }
  const app = Object.hasOwn(v, "body") ? v.body : undefined;
  const type = typeof v.type === "string" ? v.type : undefined;
  return ok({ pid, tags, type, pay: payBytes(app, pack) });
}

// Application payload bytes. Null, absent, and empty bytes carry nothing.
function payBytes(app: unknown, pack: MsgPack): Uint8Array {
  if (app === undefined || app === null) return empty;
  if (app instanceof Uint8Array) return app.length > 0 ? app : empty;
  const b = pack.encode(app);
  return b.length > 0 ? b : empty;
}

// Self-delimiting record of one message: eid, off, ctr, typ, pid, tags, payload.
function infoRec(
  msg: ExportMsg,
  typ: string,
  pid: Uint8Array,
  tags: string[],
  pay: Uint8Array,
): ValStat<Uint8Array> {
  const enc = new Encoder();
  const s0 = enc.writeVarBytes(msg.head.eid);
  if (s0 !== Status.Success) return nok(s0);
  const s1 = enc.writeVarInt(msg.head.off);
  if (s1 !== Status.Success) return nok(s1);
  const s2 = enc.writeVarInt(msg.head.ctr);
  if (s2 !== Status.Success) return nok(s2);
  const s3 = enc.writeVarString(typ);
  if (s3 !== Status.Success) return nok(s3);
  const s4 = enc.writeVarBytes(pid);
  if (s4 !== Status.Success) return nok(s4);
  const s5 = enc.writeVarStrings(tags);
  if (s5 !== Status.Success) return nok(s5);
  const s6 = enc.writeVarBytes(pay);
  if (s6 !== Status.Success) return nok(s6);
  return ok(enc.result());
}

// Reads one message as ent information, from a msgpack map or an ent frame.
function msgInfo(msg: ExportMsg, pack: MsgPack): ValStat<Uint8Array> {
  const typ0 = msg.head.typ ?? "";
  if (msg.body === undefined || msg.body.length === 0) {
    return infoRec(msg, typ0, empty, [], empty);
  }
  if (!isMsgpackMap(msg.body)) {
    const dec = new Decoder(msg.body);
    const [ent, st] = dec.readStruct(entCodec);
    if (st !== Status.Success || ent === undefined || !dec.done()) {
      return nok(Status.InvalidMessage);
    }
    return infoRec(
      msg,
      typ0,
      ent.pid ?? empty,
      ent.tags ?? [],
      ent.body ?? empty,
    );
  }
  let decoded: unknown;
  try {
    decoded = pack.decode(msg.body);
  } catch {
    return nok(Status.InvalidMessage);
  }
  const [old, stOld] = readOld(decoded, pack);
  if (stOld !== Status.Success || old === undefined) return nok(stOld);
  let typ = typ0;
  if (typ.length === 0 && old.type !== undefined) typ = old.type;
  return infoRec(msg, typ, old.pid ?? empty, old.tags ?? [], old.pay);
}

// Checksums ent information across an export.
// A pre-v0.24 body and its ent-frame rewrite share this digest.
// len and the body hash are omitted, so this digest is not msgcheck.
export async function checksumEntInfo(
  msgs: Iterable<ExportMsg>,
  hash: (data: Uint8Array) => Promise<Uint8Array>,
  pack: MsgPack,
): Promise<ValStat<Uint8Array>> {
  const recs: Uint8Array[] = [];
  for (const msg of msgs) {
    const [rec, st] = msgInfo(msg, pack);
    if (st !== Status.Success) return nok(st);
    if (rec === undefined) return nok(Status.InternalError);
    recs.push(rec);
  }
  recs.sort(cmpBytes);
  let n = 0;
  for (const r of recs) n += r.length;
  const buf = new Uint8Array(n);
  let at = 0;
  for (const r of recs) {
    buf.set(r, at);
    at += r.length;
  }
  return ok(await hash(buf));
}

// Converts each msgpack ent body to an ent frame.
// A body that is already a frame is left as it is.
// Null gid, pid, and tags are absent. Any other extra key is rejected.
// type is copied onto the head only when the head typ is empty.
// The application body is msgpack again, unless it is already bytes.
export async function entFrameMsgs(
  msgs: Iterable<ExportMsg>,
  hash: (data: Uint8Array) => Promise<Uint8Array>,
  pack: MsgPack,
): Promise<ValStat<ExportMsg[]>> {
  const out: ExportMsg[] = [];
  for (const msg of msgs) {
    if (msg.body === undefined || msg.body.length === 0) {
      out.push(msg);
      continue;
    }
    if (!isMsgpackMap(msg.body)) {
      const dec = new Decoder(msg.body);
      const [, st] = dec.readStruct(entCodec);
      if (st !== Status.Success || !dec.done()) {
        return nok(Status.InvalidMessage);
      }
      out.push(msg);
      continue;
    }
    let decoded: unknown;
    try {
      decoded = pack.decode(msg.body);
    } catch {
      return nok(Status.InvalidMessage);
    }
    const [old, stOld] = readOld(decoded, pack);
    if (stOld !== Status.Success || old === undefined) return nok(stOld);
    const ent: IMsgEntBody<Uint8Array> = {};
    if (old.pid !== undefined) ent.pid = old.pid;
    if (old.tags !== undefined && old.tags.length > 0) ent.tags = old.tags;
    if (old.pay.length > 0) ent.body = old.pay;
    const [bod, stBod] = encodeEnt(ent);
    if (stBod !== Status.Success) return nok(stBod);
    let typ = msg.head.typ;
    if ((typ === undefined || typ.length === 0) && old.type !== undefined) {
      typ = old.type;
    }
    out.push({
      head: { ...msg.head, typ, len: bod.length, hsh: await hash(bod) },
      body: bod,
      ...(msg.realm !== undefined ? { realm: msg.realm } : {}),
    });
  }
  return ok(out);
}
