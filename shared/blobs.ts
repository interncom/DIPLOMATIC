// Application blobs. The bytes are the ent body.

import { Decoder } from "./codec.ts";
import { eidCodec } from "./codecs/eid.ts";
import { encodeEnt, entCodec } from "./codecs/ent.ts";
import { Status } from "./consts.ts";
import type {
  EntityID,
  IEntRev,
  IMessage,
  IMessageHead,
  IMsgEntBody,
} from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

/** Head typ prefix. The rest is an app mime, such as "image/jpeg". */
export const blobPrefix = "blob:";

// typ for a blob. mime is the part after "blob:", not the full typ.
export function blobTyp(mime: string): string {
  return blobPrefix + mime;
}

// True when typ names a blob, including the empty mime "blob:".
export function isBlobTyp(typ: string | undefined): typ is string {
  return typ !== undefined && typ.startsWith(blobPrefix);
}

// Mime from a blob typ. Undefined when typ is not a blob or the mime is empty.
export function mimeOf(typ: string | undefined): string | undefined {
  if (!isBlobTyp(typ)) return undefined;
  const mime = typ.slice(blobPrefix.length);
  if (mime.length === 0) return undefined;
  return mime;
}

// pid and tags written with a blob. The bytes are the ent body.
export interface IBlobWrite {
  tags?: string[];
  pid?: EntityID;
}

// Update fields. A present key replaces the archived value.
// A missing key keeps it. tags: [] clears tags.
export interface IBlobUpdate extends IBlobWrite {
  mime?: string;
}

// Head typ and ent body for one blob write.
type BlobMsg = { typ: string; bod: Uint8Array };

// Reads a blob msg body. The body view aliases bod.
export function openBlob(
  bod: Uint8Array,
): ValStat<IMsgEntBody<Uint8Array>> {
  const dec = new Decoder(bod);
  return dec.readStruct(entCodec);
}

function entOf(
  opts: IBlobWrite | undefined,
  bytes: Uint8Array,
): IMsgEntBody<Uint8Array> {
  const ent: IMsgEntBody<Uint8Array> = {};
  if (opts !== undefined && opts.pid !== undefined) ent.pid = opts.pid;
  if (opts !== undefined && opts.tags !== undefined && opts.tags.length > 0) {
    ent.tags = opts.tags;
  }
  if (bytes.length > 0) ent.body = bytes;
  return ent;
}

// Keeps archived pid and tags whose keys the caller did not set.
function entFromUpdate(
  prev: IMsgEntBody<Uint8Array>,
  bytes: Uint8Array,
  opts: IBlobUpdate | undefined,
): IMsgEntBody<Uint8Array> {
  const ent: IMsgEntBody<Uint8Array> = {};
  const pid = opts !== undefined && Object.hasOwn(opts, "pid")
    ? opts.pid
    : prev.pid;
  const tags = opts !== undefined && Object.hasOwn(opts, "tags")
    ? opts.tags
    : prev.tags;
  if (pid !== undefined) ent.pid = pid;
  if (tags !== undefined && tags.length > 0) ent.tags = tags;
  if (bytes.length > 0) ent.body = bytes;
  return ent;
}

// Prior rev from a msg head (eid timestamp plus off).
function revOf(head: IMessageHead): ValStat<IEntRev> {
  const dec = new Decoder(head.eid);
  const [parsed, st] = dec.readStruct(eidCodec);
  if (st !== Status.Success) return err(st);
  return ok({
    eid: head.eid,
    ctr: head.ctr,
    updatedAt: new Date(parsed.ts.getTime() + head.off),
  });
}

// Ent body and head typ for a new blob. mime is the part after "blob:".
export function insertBlobMsg(
  mime: string,
  bytes: Uint8Array,
  opts?: IBlobWrite,
): ValStat<BlobMsg> {
  if (mime.length === 0) return err(Status.InvalidParam);
  const [bod, st] = encodeEnt(entOf(opts, bytes));
  if (st !== Status.Success) return err(st);
  return ok({ typ: blobTyp(mime), bod });
}

// Ent body, head typ, and prior for replacing the blob in prev.
// Pass tags: [] to clear tags. Omit the key to keep the archived value.
export function updateBlobMsg(
  prev: IMessage | undefined,
  bytes: Uint8Array,
  opts?: IBlobUpdate,
): ValStat<BlobMsg & { prior: IEntRev }> {
  if (prev === undefined || prev.bod === undefined || prev.bod.length === 0) {
    return err(Status.NotFound);
  }
  const prevMime = mimeOf(prev.typ);
  if (prevMime === undefined) return err(Status.InvalidParam);
  const [prior, stPrior] = revOf(prev);
  if (stPrior !== Status.Success) return err(stPrior);
  const [opened, stOpen] = openBlob(prev.bod);
  if (stOpen !== Status.Success) return err(stOpen);
  const mime = opts?.mime ?? prevMime;
  if (mime.length === 0) return err(Status.InvalidParam);
  const [bod, stBod] = encodeEnt(entFromUpdate(opened, bytes, opts));
  if (stBod !== Status.Success) return err(stBod);
  return ok({ typ: blobTyp(mime), bod, prior });
}

// Copy of the bytes in a blob msg.
// NotFound when msg is missing, not a blob, or a delete.
export function blobBytes(msg: IMessage | undefined): ValStat<Uint8Array> {
  if (msg === undefined || msg.bod === undefined || msg.bod.length === 0) {
    return err(Status.NotFound);
  }
  if (!isBlobTyp(msg.typ)) return err(Status.NotFound);
  const [opened, st] = openBlob(msg.bod);
  if (st !== Status.Success) return err(st);
  if (opened.body === undefined) return ok(new Uint8Array());
  return ok(opened.body.slice());
}
