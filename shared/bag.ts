// Bag is the encrypted message, wrapped for relay across untrusted hosts.
// Wire prefix: signature (64), rlm (32), kdm (8).
// The signature covers rlm ‖ headCph.

import { Decoder, Encoder } from "./codec.ts";
import { IMessageHead, messageHeadCodec } from "./codecs/messageHead.ts";
import { hashBytes, Status } from "./consts.ts";
import type { HostRlm } from "./crypto/derivation.ts";
import { BagManager } from "./crypto/bagman.ts";
import { bytesEqual, concat } from "./binary.ts";
import { EncodedMessage } from "./message.ts";
import { err, ok, type ValStat } from "./valstat.ts";
import type {
  Hash,
  IBag,
  ICrypto,
  IHostCrypto,
  IMessage,
  IMessageWithHash,
} from "./types.ts";

// Bytes the bag signature covers: rlm followed by the encrypted head.
export function bagSigMsg(
  rlm: HostRlm,
  headCph: Uint8Array,
): Uint8Array {
  // TODO: optimize to be zero-copy (may have to change how signature method works)
  return concat(rlm, headCph);
}

export function bagSigValid(
  bag: IBag,
  verifyKey: CryptoKey,
  crypto: IHostCrypto,
): Promise<boolean> {
  if (bag.rlm.byteLength !== hashBytes) return Promise.resolve(false);
  return crypto.checkSigEd25519(
    bag.sig,
    bagSigMsg(bag.rlm, bag.headCph), // TODO: optimize this to be zero-copy
    verifyKey,
  );
}

export async function sealBag(
  msg: IMessage,
  bagMgr: BagManager,
  crypto: ICrypto,
): Promise<ValStat<IBag>> {
  let hsh: Uint8Array | undefined;
  if (msg.bod && msg.len > 0) {
    hsh = await crypto.blake3(msg.bod);
  }

  // Encode message.
  const enc = new Encoder();
  const statEnc = messageHeadCodec.encode(enc, { ...msg, hsh });
  if (statEnc !== Status.Success) {
    return err(statEnc);
  }
  const headEnc = enc.result();

  const [kdm, kst] = await bagMgr.bagKDM(headEnc);
  if (kst !== Status.Success) return err(kst);
  const rlm = bagMgr.rlm;

  // Encrypt header and body separately, so that signed encrypted header may be served in PEEK response.
  const [headCph, hst] = await bagMgr.encrypt(kdm, headEnc);
  if (hst !== Status.Success) return err(hst);
  let bodyCph: Uint8Array = new Uint8Array(0);
  if (msg.bod) {
    const [cph, bst] = await bagMgr.encrypt(kdm, msg.bod);
    if (bst !== Status.Success) return err(bst);
    bodyCph = cph;
  }

  // Sign rlm ‖ headCph. The private key stays in the manager.
  const sigMsg = bagSigMsg(rlm, headCph);
  const [sig, sst] = await bagMgr.sign(sigMsg);
  if (sst !== Status.Success) return err(sst);
  return ok({
    rlm,
    sig,
    kdm,
    headCph,
    bodyCph,
  });
}

export interface IOpenBag {
  msgHead: IMessageHead;
  bod?: EncodedMessage;
  headHash: Hash;
}
// Decrypts a body already bound to one bag kdm.
export type BagDecrypt = {
  decrypt: (data: Uint8Array) => Promise<ValStat<Uint8Array>>;
};

export async function openBagBody(
  headEnc: Uint8Array,
  bodyCph: Uint8Array | undefined,
  cipher: BagDecrypt,
  crypto: ICrypto,
  /** When set (e.g. from peek), skip blake3(headEnc). */
  headHashKnown?: Hash,
): Promise<ValStat<IOpenBag>> {
  // Decode message.
  const dec = new Decoder(headEnc);
  const [msgHead, status] = messageHeadCodec.decode(dec);
  if (status !== Status.Success) {
    return err(Status.InvalidMessage);
  }

  // Decrypt body, if any. The key stays in the manager.
  let msgBody: Uint8Array | undefined;
  if (bodyCph && bodyCph.length > 0) {
    const [bod, dst] = await cipher.decrypt(bodyCph);
    if (dst !== Status.Success) return err(dst);
    msgBody = bod;
  }

  // Check body hash.
  const bodyMissing = msgHead.hsh && msgBody === undefined;
  const hashMissing = msgHead.hsh === undefined && msgBody !== undefined;
  if (bodyMissing || hashMissing) {
    return err(Status.HashMismatch);
  }
  if (msgHead.hsh && msgBody) {
    const bodyHash = await crypto.blake3(msgBody);
    if (!bytesEqual(bodyHash, msgHead.hsh)) {
      return err(Status.HashMismatch);
    }
  }

  // Prefer caller-supplied head hash (peek already computed it).
  const headHash = headHashKnown ?? await crypto.blake3(headEnc);

  return ok({ msgHead, bod: msgBody, headHash });
}

export async function openBag(
  bag: IBag,
  verifyKey: CryptoKey,
  crypto: ICrypto,
  bagMgr: BagManager,
): Promise<ValStat<IMessageWithHash>> {
  // Check sig over rlm ‖ headCph.
  const sigValid = await bagSigValid(bag, verifyKey, crypto);
  if (!sigValid) {
    return err(Status.InvalidSignature);
  }
  if (!bytesEqual(bagMgr.rlm, bag.rlm)) return err(Status.NotFound);

  // Decrypt head. The key stays in the manager.
  const [msgHeadEnc, dst] = await bagMgr.decrypt(bag.kdm, bag.headCph);
  if (dst !== Status.Success) return err(dst);

  const [contents, status] = await openBagBody(
    msgHeadEnc,
    bag.bodyCph,
    { decrypt: (data) => bagMgr.decrypt(bag.kdm, data) },
    crypto,
  );
  if (status !== Status.Success) {
    return err(status);
  }

  // Reconstruct message.
  const { msgHead, bod, headHash } = contents;
  return ok({ ...msgHead, bod, headHash });
}
