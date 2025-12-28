import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { makeEnvelope } from "../../shared/envelope.ts";
import { Encoder, Decoder } from "../../shared/codec.ts";
import { envelopeCodec } from "../../shared/protocol.ts";
import {
  kdmBytes,
  encodeOp,
  decodeOp,
  genKDM,
  type IMessage,
} from "../../shared/message.ts";
import { concat } from "../../shared/lib.ts";
import libsodiumCrypto from "../src/crypto.ts";
import type { MasterSeed, EncodedEnvelope } from "../../shared/types.ts";
import { Enclave } from "../../shared/enclave.ts";

// Setup crypto and keypair
const crypto = libsodiumCrypto;
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);
const hostKDM = await enclave.derive("benchmark-host", 0);
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(hostKDM);

// Create the op containing "HELLO DIPLOMATIC"
const eid = await crypto.gen128BitRandomID();
const bod = new TextEncoder().encode("HELLO DIPLOMATIC");
const op: IMessage = {
  eid,
  clk: new Date(),
  ctr: 1,
  len: bod.length,
  bod,
};

async function fullyEncodeEnvelope(op: IMessage): Promise<Uint8Array> {
  const [encMsg, msgHead] = await encodeOp(op, crypto);
  const kdm = await genKDM(crypto);
  const encKey = await enclave.deriveFromKDM(kdm);
  const headCph = await crypto.encryptXSalsa20Poly1305Combined(msgHead, encKey);
  if (!op.bod) {
    throw new Error("ahhh!");
  }
  const bodyCph = await crypto.encryptXSalsa20Poly1305Combined(op.bod, encKey);
  const env = await makeEnvelope(keyPair, headCph, bodyCph, kdm, crypto);
  const enc = new Encoder();
  enc.writeStruct(envelopeCodec, env);
  return enc.result();
}

Deno.bench("full encode op", async (b) => {
  await fullyEncodeEnvelope(op);
});

const envelope = await fullyEncodeEnvelope(op);

Deno.bench("full decode op", async (b) => {
  const decoder = new Decoder(envelope);
  const decodedEnv = decoder.readStruct(envelopeCodec);
  const kdm = decodedEnv.kdm;
  const cipherMsg = concat(decodedEnv.headCph, decodedEnv.bodyCph);
  const encKey = await enclave.deriveFromKDM(kdm);
  const decryptedHead = await crypto.decryptXSalsa20Poly1305Combined(
    decodedEnv.headCph,
    encKey,
  );
  const decryptedBody = await crypto.decryptXSalsa20Poly1305Combined(
    decodedEnv.bodyCph,
    encKey,
  );
  const decryptedMsg = concat(decryptedHead, decryptedBody);
  const msg = await decodeOp(decryptedMsg);

  // Verify the body
  const decodedBody = new TextDecoder().decode(msg.bod);
  assertEquals(decodedBody, "HELLO DIPLOMATIC");
});
