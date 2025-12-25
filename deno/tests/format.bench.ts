import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

import {
  encodeEnvelope,
  makeEnvelope,
  decodeEnvelope,
  type IEnvelope,
  type EncodedEnvelope,
} from "../../web/src/shared/envelope.ts";
import {
  keyPathBytes,
  encodeOp,
  decodeOp,
  derivationKeyMaterial,
  type IMessage,
} from "../../web/src/shared/message.ts";
import libsodiumCrypto from "../src/crypto.ts";
import type { MasterSeed } from "../../web/src/shared/types.ts";
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
  const [encMsg, msgHead] = await encodeOp(op);
  const kdm = await derivationKeyMaterial(crypto);
  const encKey = await enclave.deriveFromKDM(kdm);
  const ciphertxt = await crypto.encryptXSalsa20Poly1305Combined(
    encMsg,
    encKey,
  );
  const env = await makeEnvelope(keyPair, ciphertxt, kdm, crypto);
  return encodeEnvelope(env);
}

Deno.bench("full encode op", async (b) => {
  await fullyEncodeEnvelope(op);
});

const envelope = await fullyEncodeEnvelope(op);

Deno.bench("full decode op", async (b) => {
  const decodedEnv = await decodeEnvelope(envelope);
  const kdm = decodedEnv.msg.slice(0, keyPathBytes);
  const cipherMsg = decodedEnv.msg.slice(keyPathBytes);
  const encKey = await enclave.deriveFromKDM(kdm);
  const decryptedMsg = await crypto.decryptXSalsa20Poly1305Combined(
    cipherMsg,
    encKey,
  );
  const msg = await decodeOp(decryptedMsg);

  // Verify the body
  const decodedBody = new TextDecoder().decode(msg.bod);
  assertEquals(decodedBody, "HELLO DIPLOMATIC");
});
