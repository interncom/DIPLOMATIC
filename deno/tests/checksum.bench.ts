// Benchmark msg-set checksum: sort + concat + blake3 over N head hashes.

import { checksumSet } from "../../shared/checksum.ts";
import type { Hash } from "../../shared/types.ts";
import libsodiumCrypto from "../src/crypto.ts";

const crypto = libsodiumCrypto;
const HASH_LEN = 32;

/** Deterministic pseudo-hashes (not crypto-random; avoids RNG in setup noise). */
function makeHashes(n: number): Hash[] {
  const out: Hash[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = new Uint8Array(HASH_LEN);
    // Mix index into all 32 bytes so sort is not already ordered.
    for (let j = 0; j < HASH_LEN; j++) {
      h[j] = (i * 131 + j * 17 + (i >>> (j % 24))) & 0xff;
    }
    // Ensure uniqueness even if mix collides (rare).
    h[0] = (i >>> 24) & 0xff;
    h[1] = (i >>> 16) & 0xff;
    h[2] = (i >>> 8) & 0xff;
    h[3] = i & 0xff;
    out[i] = h as Hash;
  }
  return out;
}

const sizes = [
  { n: 1_000, label: "1k" },
  { n: 10_000, label: "10k" },
  { n: 100_000, label: "100k" },
  { n: 1_000_000, label: "1m" },
];

for (const { n, label } of sizes) {
  const hashes = makeHashes(n);

  Deno.bench(`checksumSet (${label} hashes)`, {
    // 1m is heavy; fewer group samples keep the suite usable.
    group: "checksumSet",
    baseline: n === 1_000,
  }, async () => {
    // Copy the array so each iter pays full sort cost (sort is in-place).
    const copy = hashes.slice();
    await checksumSet(copy, crypto);
  });
}

// Isolate phases at 100k for attribution (sort/concat vs blake3).
{
  const n = 100_000;
  const hashes = makeHashes(n);
  const sorted = hashes.slice().sort((a, b) => {
    for (let i = 0; i < HASH_LEN; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  });
  const concat = new Uint8Array(n * HASH_LEN);
  for (let i = 0; i < n; i++) {
    concat.set(sorted[i], i * HASH_LEN);
  }

  Deno.bench("checksumSet phases (100k): sort only", () => {
    const copy = hashes.slice();
    copy.sort((a, b) => {
      for (let i = 0; i < HASH_LEN; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    });
  });

  Deno.bench("checksumSet phases (100k): blake3 concat only", async () => {
    await crypto.blake3(concat);
  });
}
