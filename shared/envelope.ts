// Envelope is the encrypted message, wrapped with data to support the relay protocol across untrusted hosts.

// The envelope includes a fixed-size header: signature (64), kdm (8), totaling 72 bytes.
// The ciphertext follows without an embedded length field, as its length is part of the encrypted message header.

import { Decoder, Encoder } from "./codec.ts";
import { IMessageHead, messageHeadCodec } from "./codecs/messageHead.ts";
import { kdmBytes, sigBytes } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { genKDM, IMessage } from "./message.ts";
import type {
  ICrypto,
  IEnvelope,
  IEnvelopeHeader,
  IHostCrypto,
  KeyPair,
  PublicKey,
} from "./types.ts";

export async function makeEnvelope(
  keyPair: KeyPair,
  headCph: Uint8Array,
  bodyCph: Uint8Array,
  kdm: Uint8Array,
  crypto: ICrypto,
): Promise<IEnvelope> {
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

export function decodeEnvelopeHeader(encoded: Uint8Array): IEnvelopeHeader {
  const dec = new Decoder(encoded);
  const sig = dec.readBytes(sigBytes);
  const kdm = dec.readBytes(kdmBytes);
  const lenHeadCph = dec.readVarInt();
  const lenBodyCph = dec.readVarInt();
  return { sig, kdm, lenHeadCph, lenBodyCph };
}

export function envSigValid(
  env: IEnvelope,
  pubKey: PublicKey,
  crypto: IHostCrypto,
): Promise<boolean> {
  return crypto.checkSigEd25519(env.sig, env.headCph, pubKey);
}

export async function envelopeFor(
  op: IMessage,
  keyPair: KeyPair,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<IEnvelope> {
  let hsh: Uint8Array | undefined;
  if (op.bod && op.len > 0) {
    hsh = await crypto.blake3(op.bod);
  }
  const msgHead: IMessageHead = {
    eid: op.eid,
    clk: op.clk,
    ctr: op.ctr,
    len: op.len,
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
  const bodyCph = op.bod
    ? await crypto.encryptXSalsa20Poly1305Combined(op.bod, key)
    : new Uint8Array(0);

  // Wrap in envelope.
  return makeEnvelope(keyPair, headCph, bodyCph, kdm, crypto);
}
