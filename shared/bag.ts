// Bag is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.
// The bag includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.

import { Decoder, Encoder } from "./codec.ts";
import { IMessageHead, messageHeadCodec } from "./codecs/messageHead.ts";
import { kdmBytes, Status } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { concat, uint8ArraysEqual } from "./binary.ts";
import { EncodedMessage, IMessage, IMessageWithHash } from "./message.ts";
import { ok, err, type ValStat } from "./valstat.ts";
import type {
  Hash,
  HostSpecificKeyPair,
  IBag,
  ICrypto,
  IHostCrypto,
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
  keys: HostSpecificKeyPair,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<IBag> {
  let hsh: Uint8Array | undefined;
  if (msg.bod && msg.len > 0) {
    hsh = await crypto.blake3(msg.bod);
  }

  // Encode message.
  const enc = new Encoder();
  messageHeadCodec.encode(enc, { ...msg, hsh });
  const headEnc = enc.result();

  // Derive encryption key.
  // 1. We use a different key for each bag, so that cracking one key does
  //    not compromise all of the user's bags.
  // 2. Deterministically deriving the KDM from the plaintext message head
  //    prevents an attarcker from forging arbitrary bags if they get a key.
  // 3. Mixing the host-specific private key in prevents that deterministic
  //    KDM from being used as a unique identifier across hosts.
  const kdmSource = concat(keys.privateKey, headEnc);
  const kdmHash = await crypto.blake3(kdmSource);
  const kdm = kdmHash.slice(0, kdmBytes);
  const key = await enclave.deriveFromKDM(kdm);

  // Encrypt header and body separately, so that signed encrypted header may be served in PEEK response.
  const headCph = await crypto.encryptXSalsa20Poly1305Combined(headEnc, key);
  const bodyCph = msg.bod
    ? await crypto.encryptXSalsa20Poly1305Combined(msg.bod, key)
    : new Uint8Array(0);

  // Wrap in bag.
  const sig = await crypto.signEd25519(headCph, keys.privateKey);
  return {
    sig,
    kdm,
    lenHeadCph: headCph.length,
    lenBodyCph: bodyCph.length,
    headCph,
    bodyCph,
  };
}

export async function openBagBody(
  headEnc: Uint8Array,
  bodyCph: Uint8Array | undefined,
  key: Uint8Array,
  crypto: ICrypto,
): Promise<ValStat<{ msgHead: IMessageHead; bod?: EncodedMessage; headHash: Hash }>> {
  // Decode message.
  const dec = new Decoder(headEnc);
  const [msgHead, status] = messageHeadCodec.decode(dec);
  if (status !== Status.Success) {
    return err(Status.InvalidMessage);
  }

  // Decrypt body, if any.
  let msgBody: Uint8Array | undefined;
  try {
    msgBody = bodyCph && bodyCph.length > 0
      ? await crypto.decryptXSalsa20Poly1305Combined(bodyCph, key)
      : undefined;
  } catch (e) {
    return err(Status.DecryptionError);
  }

  const bodyMissing = msgHead.hsh && msgBody === undefined;
  const hashMissing = msgHead.hsh === undefined && msgBody !== undefined;
  if (bodyMissing || hashMissing) {
    return err(Status.HashMismatch);
  }

  // Check body hash.
  if (msgHead.hsh && msgBody) {
    const bodyHash = await crypto.blake3(msgBody);
    if (!uint8ArraysEqual(bodyHash, msgHead.hsh)) {
      return err(Status.HashMismatch);
    }
  }
  const headHash = await crypto.blake3(headEnc);
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

  // Derive key.
  const key = await enclave.deriveFromKDM(bag.kdm);

  // Decrypt head.
  const msgHeadEnc = await crypto.decryptXSalsa20Poly1305Combined(
    bag.headCph,
    key,
  );

  // Use openBagBody for the rest.
  const [contents, status] = await openBagBody(msgHeadEnc, bag.bodyCph, key, crypto);
  if (status !== Status.Success) {
    return err(status);
  }

  // Reconstruct message.
  const { msgHead, bod, headHash } = contents;
  return ok({ ...msgHead, bod, headHash });
}
