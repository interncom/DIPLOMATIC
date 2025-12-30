// Bag is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.
// The bag includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.

import { Decoder, Encoder } from "./codec.ts";
import { IMessageHead, messageHeadCodec } from "./codecs/messageHead.ts";
import { kdmBytes } from "./consts.ts";
import { Enclave } from "./enclave.ts";
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
  // Verify signature.
  const isValid = await crypto.checkSigEd25519(bag.sig, bag.headCph, pubKey);
  if (!isValid) {
    throw new Error("Invalid signature");
  }

  // Derive encryption key.
  const key = await enclave.deriveFromKDM(bag.kdm);

  // Decrypt header.
  const decryptedHead = await crypto.decryptXSalsa20Poly1305Combined(
    bag.headCph,
    key,
  );

  // Decrypt body if present.
  const decryptedBody = bag.bodyCph.length > 0
    ? await crypto.decryptXSalsa20Poly1305Combined(bag.bodyCph, key)
    : undefined;

  // Decode message head.
  const dec = new Decoder(decryptedHead);
  const msgHead = messageHeadCodec.decode(dec);

  // Verify hash if body is present.
  if (msgHead.hsh && decryptedBody) {
    const computedHsh = await crypto.blake3(decryptedBody);
    if (!computedHsh.every((byte, i) => byte === msgHead.hsh![i])) {
      throw new Error("Hash mismatch");
    }
  }

  return {
    eid: msgHead.eid,
    clk: msgHead.clk,
    ctr: msgHead.ctr,
    len: msgHead.len,
    bod: decryptedBody,
  };
}

export async function genKDM(crypto: ICrypto): Promise<Uint8Array> {
  const random = await crypto.gen128BitRandomID();
  return random.slice(0, kdmBytes);
}
