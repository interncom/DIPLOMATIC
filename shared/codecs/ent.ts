// Encodes an ent body: optional pid, tags, then raw application bytes.

import { Decoder, Encoder, ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { EntityID, IMsgEntBody } from "../types.ts";
import { err, ok, ValStat } from "../valstat.ts";
import { eidCodec, makeEID } from "./eid.ts";

const empty = new Uint8Array(0);

// Ordered ent body: pid varbytes, tag count, var-strings, raw body.
export const entCodec: ICodecStruct<IMsgEntBody<Uint8Array>> = {
  encode(enc, ent) {
    if (ent.body !== undefined && !(ent.body instanceof Uint8Array)) {
      return Status.InvalidParam;
    }
    const s1 = enc.writeVarBytes(ent.pid ?? empty);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarStrings(ent.tags ?? []);
    if (s2 !== Status.Success) return s2;
    if (ent.body !== undefined && ent.body.length > 0) {
      enc.writeBytes(ent.body);
    }
    return Status.Success;
  },
  decode(dec) {
    const [pidBytes, s1] = dec.readVarBytes();
    if (s1 !== Status.Success) return err(s1);
    let pid: EntityID | undefined;
    if (pidBytes.length > 0) {
      const inner = new Decoder(pidBytes);
      const [parsed, sp] = inner.readStruct(eidCodec);
      if (sp !== Status.Success) return err(sp);
      if (!inner.done()) return err(Status.InvalidMessage);
      const [eid, se] = makeEID(parsed);
      if (se !== Status.Success) return err(se);
      pid = eid;
    }
    const [tags, s2] = dec.readVarStrings();
    if (s2 !== Status.Success) return err(s2);
    const rest = dec.readRest();
    const ent: IMsgEntBody<Uint8Array> = {};
    if (pid !== undefined) ent.pid = pid;
    if (tags.length > 0) ent.tags = tags;
    if (rest.length > 0) ent.body = rest;
    return ok(ent);
  },
};

// Packs pid, tags, and body into one message body.
export function encodeEnt(
  ent: IMsgEntBody<Uint8Array>,
): ValStat<Uint8Array> {
  const enc = new Encoder();
  const st = enc.writeStruct(entCodec, ent);
  if (st !== Status.Success) return err(st);
  return ok(enc.result());
}
