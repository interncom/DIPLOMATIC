// Bag is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.
// The bag includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.

import { Decoder, Encoder } from "./codec.ts";
import { messageHeadCodec } from "./codecs/messageHead.ts";
import { kdmBytes } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { concat, uint8ArraysEqual } from "./binary.ts";
import { IMessage, IMessageWithHash } from "./message.ts";
import type {
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

export async function openBag(
  bag: IBag,
  pubKey: PublicKey,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<IMessageWithHash> {
  // Check sig.
  const sigValid = await crypto.checkSigEd25519(bag.sig, bag.headCph, pubKey);
  if (!sigValid) {
    throw new Error("Invalid signature");
  }

  // Derive key.
  const key = await enclave.deriveFromKDM(bag.kdm);

  // Decrypt.
  const msgHeadEnc = await crypto.decryptXSalsa20Poly1305Combined(
    bag.headCph,
    key,
  );
  const msgBody = bag.bodyCph.length > 0
    ? await crypto.decryptXSalsa20Poly1305Combined(bag.bodyCph, key)
    : undefined;

  // Decode.
  const dec = new Decoder(msgHeadEnc);
  const msgHead = messageHeadCodec.decode(dec);

  // Check hash.
  if (msgHead.hsh && msgBody) {
    const bodyHash = await crypto.blake3(msgBody);
    if (!uint8ArraysEqual(bodyHash, msgHead.hsh)) {
      throw new Error("Hash mismatch");
    }
  }

  // Compute message hash (hash of head, which includes body hash).
  const headHash = await crypto.blake3(msgHeadEnc);

  // Reconstruct message.
  return { ...msgHead, bod: msgBody, headHash };
}
