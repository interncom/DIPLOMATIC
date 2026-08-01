// Bag is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.
// The bag includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.

import { Decoder, Encoder } from "./codec.ts";
import { IMessageHead, messageHeadCodec } from "./codecs/messageHead.ts";
import { Status } from "./consts.ts";
import {
  type DecryptCipher,
  Enclave,
  type Identity,
} from "./crypto/enclave.ts";
import { bytesEqual } from "./binary.ts";
import { EncodedMessage } from "./message.ts";
import { err, ok, type ValStat } from "./valstat.ts";
import type {
  Hash,
  IBag,
  ICrypto,
  IHostCrypto,
  IMessage,
  IMessageWithHash,
  PublicKey,
} from "./types.ts";

export function bagSigValid(
  bag: IBag,
  pubKey: PublicKey,
  crypto: IHostCrypto,
): Promise<boolean> {
  return crypto.checkSigEd25519(bag.sig, bag.headCph, pubKey);
}

export async function sealBag(
  msg: IMessage,
  identity: Identity,
  crypto: ICrypto,
  enclave: Enclave,
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

  // KDM via identity (private key stays in enclave); cipher is opaque.
  const kdm = await identity.kdmFor(headEnc);
  const cipher = enclave.deriveCipher(kdm, "encrypt");

  // Encrypt header and body separately, so that signed encrypted header may be served in PEEK response.
  const headCph = await cipher.encrypt(headEnc);
  const bodyCph = msg.bod ? await cipher.encrypt(msg.bod) : new Uint8Array(0);

  // Sign ciphertext (private key stays in enclave).
  const sig = await identity.sign(headCph);
  return ok({
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
export async function openBagBody(
  headEnc: Uint8Array,
  bodyCph: Uint8Array | undefined,
  cipher: DecryptCipher,
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

  // Decrypt body, if any (key stays in the enclave via cipher).
  let msgBody: Uint8Array | undefined;
  try {
    msgBody = bodyCph && bodyCph.length > 0
      ? await cipher.decrypt(bodyCph)
      : undefined;
  } catch {
    return err(Status.DecryptionError);
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
  pubKey: PublicKey,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<ValStat<IMessageWithHash>> {
  // Check sig.
  const sigValid = await crypto.checkSigEd25519(bag.sig, bag.headCph, pubKey);
  if (!sigValid) {
    return err(Status.InvalidSignature);
  }

  const cipher = enclave.deriveCipher(bag.kdm, "decrypt");

  // Decrypt head (key stays in the enclave via cipher).
  let msgHeadEnc: Uint8Array;
  try {
    msgHeadEnc = await cipher.decrypt(bag.headCph);
  } catch {
    return err(Status.DecryptionError);
  }

  // Use openBagBody for the rest.
  const [contents, status] = await openBagBody(
    msgHeadEnc,
    bag.bodyCph,
    cipher,
    crypto,
  );
  if (status !== Status.Success) {
    return err(status);
  }

  // Reconstruct message.
  const { msgHead, bod, headHash } = contents;
  return ok({ ...msgHead, bod, headHash });
}
