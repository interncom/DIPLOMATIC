import {
  encodeOpForHost,
  formOpForHost,
  encryptOp,
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
