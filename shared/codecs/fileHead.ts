// Signed export header: the nonce, the realm directory, then hash and signature.

import { Decoder, Encoder, ICodecStruct } from "../codec.ts";
import { hashBytes, hshBytes, sigBytes, Status } from "../consts.ts";
import type { Hash } from "../types.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { fileRealmCodec, type IFileRealm } from "./fileRealm.ts";

export interface IFileHead {
  nonce: Uint8Array; // KDM of the export file key.
  realms: IFileRealm[]; // Realm directory. Empty for an empty file.
  hsh: Hash; // blake3 of the nonce, then the realm directory.
  sig: Uint8Array; // Ed25519 signature of hsh.
}

// Nonce then the realm directory. The file hash covers these bytes.
export function fileHeadPreimage(
  nonce: Uint8Array,
  realms: readonly IFileRealm[],
): ValStat<Uint8Array> {
  if (nonce.byteLength !== hashBytes) return err(Status.InvalidParam);
  const enc = new Encoder();
  enc.writeBytes(nonce);
  const st = writeRealms(enc, realms);
  if (st !== Status.Success) return err(st);
  return ok(enc.result());
}

export const fileHeadCodec: ICodecStruct<IFileHead> = {
  encode(enc, head) {
    if (head.nonce.byteLength !== hashBytes) return Status.InvalidParam;
    if (head.hsh.byteLength !== hshBytes) return Status.InvalidParam;
    if (head.sig.byteLength !== sigBytes) return Status.InvalidParam;
    enc.writeBytes(head.nonce);
    const st = writeRealms(enc, head.realms);
    if (st !== Status.Success) return st;
    enc.writeBytes(head.hsh);
    enc.writeBytes(head.sig);
    return Status.Success;
  },
  decode(dec) {
    const [nonce, s0] = dec.readBytes(hashBytes);
    if (s0 !== Status.Success) return err(s0);
    const [realms, s1] = readRealms(dec);
    if (s1 !== Status.Success) return err(s1);
    const [hsh, s2] = dec.readBytes(hshBytes);
    if (s2 !== Status.Success) return err(s2);
    const [sig, s3] = dec.readBytes(sigBytes);
    if (s3 !== Status.Success) return err(s3);
    return ok({ nonce, realms, hsh: hsh as Hash, sig });
  },
};

function writeRealms(enc: Encoder, realms: readonly IFileRealm[]): Status {
  const s0 = enc.writeVarInt(realms.length);
  if (s0 !== Status.Success) return s0;
  for (const row of realms) {
    const st = fileRealmCodec.encode(enc, row);
    if (st !== Status.Success) return st;
  }
  return Status.Success;
}

function readRealms(dec: Decoder): ValStat<IFileRealm[]> {
  const [n, s0] = dec.readVarInt();
  if (s0 !== Status.Success) return err(s0);
  // Each record is longer than one byte, so a count past the buffer is invalid.
  if (!Number.isInteger(n) || n < 0 || n > dec.remaining()) {
    return err(Status.InvalidMessage);
  }
  const realms: IFileRealm[] = [];
  for (let i = 0; i < n; i++) {
    const [row, st] = fileRealmCodec.decode(dec);
    if (st !== Status.Success) return err(st);
    realms.push(row);
  }
  return ok(realms);
}
