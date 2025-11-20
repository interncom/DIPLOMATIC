import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

import {
  encodeOpForHost,
  formOpForHost,
  encryptOp,
  decryptOp,
  decodeOpForHost,
  type IProtoOpMinimal,
} from "../../web/src/shared/format.ts";
import libsodiumCrypto from "../src/crypto.ts";
import type { KeyPair } from "../../web/src/shared/types.ts";

Deno.bench("full encode op", async (b) => {
  // Setup crypto and keypair
  const crypto = libsodiumCrypto;
  const seed = await crypto.gen256BitSecureRandomSeed();
  const keyPair = await crypto.deriveEd25519KeyPair(seed, "benchmark-host", 0);

  // Create the op containing "HELLO DIPLOMATIC"
  const eid = await crypto.gen128BitRandomID();
  const op: IProtoOpMinimal = {
    eid,
    clk: new Date(),
    ctr: 1,
    body: new TextEncoder().encode("HELLO DIPLOMATIC"),
  };

  // Fully encode the op
  const idx = 0;
  const cipherOp = await encryptOp(op, crypto);
  const protoHost = await formOpForHost(keyPair, cipherOp, crypto);
  const encoded = await encodeOpForHost(idx, protoHost);

  // Benchmark measures the above operations
});

Deno.bench("full decode op", async (b) => {
  // Setup crypto and keypair
  const crypto = libsodiumCrypto;
  const seed = await crypto.gen256BitSecureRandomSeed();
  const keyPair = await crypto.deriveEd25519KeyPair(seed, "benchmark-host", 0);

  // Create and fully encode the op containing "HELLO DIPLOMATIC"
  const eid = await crypto.gen128BitRandomID();
  const op: IProtoOpMinimal = {
    eid,
    clk: new Date(),
    ctr: 1,
    body: new TextEncoder().encode("HELLO DIPLOMATIC"),
  };
  const idx = 0;
  const cipherOp = await encryptOp(op, crypto);
  const protoHost = await formOpForHost(keyPair, cipherOp, crypto);
  const encoded = await encodeOpForHost(idx, protoHost);

  // Fully decode and decrypt the op
  const decodedProto = await decodeOpForHost(encoded);
  const decryptedOp = await decryptOp(decodedProto.cipherOp, crypto);

  // Verify the body
  const decodedBody = new TextDecoder().decode(decryptedOp.body);
  assertEquals(decodedBody, "HELLO DIPLOMATIC");

  // Benchmark measures the above operations
});
