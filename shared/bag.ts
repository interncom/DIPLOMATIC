// Bag is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.
// The bag includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.

import { Decoder, Encoder } from "./codec.ts";
import { IMessageHead, messageHeadCodec } from "./codecs/messageHead.ts";
import { kdmBytes } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { uint8ArraysEqual } from "./lib.ts";
import { IMessage } from "./message.ts";
import type {
  IBag,
  ICrypto,
  IHostCrypto,
  KeyPair,
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
  keyPair: KeyPair,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<IBag> {
  let hsh: Uint8Array | undefined;
  if (msg.bod && msg.len > 0) {
    hsh = await crypto.blake3(msg.bod);
  }
  const msgHead: IMessageHead = {
    eid: msg.eid,
    clk: msg.clk,
    ctr: msg.ctr,
    len: msg.len,
    hsh,
  };

  // Encode message.
  const enc = new Encoder();
  messageHeadCodec.encode(enc, msgHead);
  const head = enc.result();

  // Derive encryption key.
  const kdm = await genKDM(crypto);
  const key = await enclave.deriveFromKDM(kdm);

  // Encrypt header and body separately, so that signed encrypted header may be served in PEEK response.
  const headCph = await crypto.encryptXSalsa20Poly1305Combined(head, key);
  const bodyCph = msg.bod
    ? await crypto.encryptXSalsa20Poly1305Combined(msg.bod, key)
    : new Uint8Array(0);

  // Wrap in bag.
  const sig = await crypto.signEd25519(headCph, keyPair.privateKey);
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
): Promise<IMessage> {
  const sigValid = await crypto.checkSigEd25519(bag.sig, bag.headCph, pubKey);
  if (!sigValid) {
    throw new Error("Invalid signature");
  }

  const key = await enclave.deriveFromKDM(bag.kdm);
  const bagHead = await crypto.decryptXSalsa20Poly1305Combined(
    bag.headCph,
    key,
  );
  const bagBody = bag.bodyCph.length > 0
    ? await crypto.decryptXSalsa20Poly1305Combined(bag.bodyCph, key)
    : undefined;

  const dec = new Decoder(bagHead);
  const msgHead = messageHeadCodec.decode(dec);

  // Verify hash if body is present.
  if (msgHead.hsh && bagBody) {
    const bodyHash = await crypto.blake3(bagBody);
    if (!uint8ArraysEqual(bodyHash, msgHead.hsh)) {
      throw new Error("Hash mismatch");
    }
  }

  return { ...msgHead, bod: bagBody };
}

export async function genKDM(crypto: ICrypto): Promise<Uint8Array> {
  const random = await crypto.gen128BitRandomID();
  return random.slice(0, kdmBytes);
}
