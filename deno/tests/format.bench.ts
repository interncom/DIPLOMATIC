import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

import {
  encodeEnvelope,
  makeEnvelope,
  decodeEnvelope,
} from "../../web/src/shared/envelope.ts";
import {
  encryptOp,
  decryptOp,
  IMessage,
} from "../../web/src/shared/message.ts";
import libsodiumCrypto from "../src/crypto.ts";
import type { KeyPair } from "../../web/src/shared/types.ts";

Deno.bench("full encode op", async (b) => {
  // Setup crypto and keypair
  const crypto = libsodiumCrypto;
  const seed = await crypto.gen256BitSecureRandomSeed();
  const keyPair = await crypto.deriveEd25519KeyPair(seed, "benchmark-host", 0);

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

  // Fully encode the op
  const idx = 0;
  const cipherOp = await encryptOp(op, crypto);
  const protoHost = await makeEnvelope(keyPair, cipherOp, crypto);
  const encoded = await encodeEnvelope(idx, protoHost);

  // Benchmark measures the above operations
});

Deno.bench("full decode op", async (b) => {
  // Setup crypto and keypair
  const crypto = libsodiumCrypto;
  const seed = await crypto.gen256BitSecureRandomSeed();
  const keyPair = await crypto.deriveEd25519KeyPair(seed, "benchmark-host", 0);

  // Create and fully encode the op containing "HELLO DIPLOMATIC"
  const eid = await crypto.gen128BitRandomID();
  const bod = new TextEncoder().encode("HELLO DIPLOMATIC");
  const op: IMessage = {
    eid,
    clk: new Date(),
    ctr: 1,
    len: bod.length,
    bod,
  };
  const idx = 0;
  const cipherOp = await encryptOp(op, crypto);
  const protoHost = await makeEnvelope(keyPair, cipherOp, crypto);
  const encoded = await encodeEnvelope(idx, protoHost);

  // Fully decode and decrypt the op
  const decodedProto = await decodeEnvelope(encoded);
  const decryptedOp = await decryptOp(decodedProto.msg, crypto);

  // Verify the body
  const decodedBody = new TextDecoder().decode(decryptedOp.bod);
  assertEquals(decodedBody, "HELLO DIPLOMATIC");

  // Benchmark measures the above operations
});
