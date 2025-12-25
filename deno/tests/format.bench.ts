import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import {
  encodeEnvelope,
  makeEnvelope,
  decodeEnvelope,
  type IEnvelope,
  type EncodedEnvelope,
} from "../../shared/envelope.ts";
import { Encoder, Decoder } from "../../shared/codec.ts";
import {
  kdmBytes,
  encodeOp,
  decodeOp,
  derivationKeyMaterial,
  type IMessage,
} from "../../shared/message.ts";
import { concat } from "../../shared/lib.ts";
import libsodiumCrypto from "../src/crypto.ts";
import type { MasterSeed } from "../../shared/types.ts";
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

async function fullyEncodeEnvelope(op: IMessage): Promise<EncodedEnvelope> {
  const [encMsg, msgHead] = await encodeOp(op, crypto);
  const kdm = await derivationKeyMaterial(crypto);
  const encKey = await enclave.deriveFromKDM(kdm);
  const cipherhead = await crypto.encryptXSalsa20Poly1305Combined(
    msgHead,
    encKey,
  );
  if (!op.bod) {
    throw new Error("ahhh!");
  }
  const cipherbody = await crypto.encryptXSalsa20Poly1305Combined(
    op.bod,
    encKey,
  );
  const env = await makeEnvelope(keyPair, cipherhead, cipherbody, kdm, crypto);
  return encodeEnvelope(env);
}

Deno.bench("full encode op", async (b) => {
  await fullyEncodeEnvelope(op);
});

const envelope = await fullyEncodeEnvelope(op);

Deno.bench("full decode op", async (b) => {
  const decoder = new Decoder(envelope);
  const decodedEnv = decodeEnvelope(decoder);
  const kdm = decodedEnv.kdm;
  const cipherMsg = concat(decodedEnv.cipherhead, decodedEnv.cipherbody);
  const encKey = await enclave.deriveFromKDM(kdm);
  const decryptedHead = await crypto.decryptXSalsa20Poly1305Combined(
    decodedEnv.cipherhead,
    encKey,
  );
  const decryptedBody = await crypto.decryptXSalsa20Poly1305Combined(
    decodedEnv.cipherbody,
    encKey,
  );
  const decryptedMsg = concat(decryptedHead, decryptedBody);
  const msg = await decodeOp(decryptedMsg);

  // Verify the body
  const decodedBody = new TextDecoder().decode(msg.bod);
  assertEquals(decodedBody, "HELLO DIPLOMATIC");
});
