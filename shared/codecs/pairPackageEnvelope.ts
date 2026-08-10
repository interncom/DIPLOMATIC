// Outer pair-package envelope: version, salt, optional credId, AEAD body.

import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";

export const PAIR_PACKAGE_VERSION = 1;

export type PairPackageEnvelope = {
  v: number;
  salt: Uint8Array;
  /** Empty when absent. */
  credId: Uint8Array;
  /** AEAD ciphertext of pairPackagePlainCodec bytes under KDF(PRF). */
  body: Uint8Array;
};

/**
 * Outer envelope (metadata is not secret; body is AEAD ciphertext):
 *   v: varint
 *   salt: varbytes
 *   credId: varbytes (length 0 if none)
 *   body: varbytes (AEAD of pair-package plain)
 */
export const pairPackageEnvelopeCodec: ICodecStruct<PairPackageEnvelope> = {
  encode(enc, e) {
    const s0 = enc.writeVarInt(e.v);
    if (s0 !== Status.Success) return s0;
    const s1 = enc.writeVarBytes(e.salt);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarBytes(e.credId);
    if (s2 !== Status.Success) return s2;
    return enc.writeVarBytes(e.body);
  },
  decode(dec) {
    const [v, s0] = dec.readVarInt();
    if (s0 !== Status.Success) return err(s0);
    if (v === undefined) return err(Status.InvalidMessage);
    const [salt, s1] = dec.readVarBytes();
    if (s1 !== Status.Success) return err(s1);
    if (salt === undefined) return err(Status.InvalidMessage);
    const [credId, s2] = dec.readVarBytes();
    if (s2 !== Status.Success) return err(s2);
    if (credId === undefined) return err(Status.InvalidMessage);
    const [body, s3] = dec.readVarBytes();
    if (s3 !== Status.Success) return err(s3);
    if (body === undefined) return err(Status.InvalidMessage);
    return ok({ v, salt, credId, body });
  },
};
