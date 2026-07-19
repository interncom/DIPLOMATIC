// Unit tests for IStorage.setBags / getBodies (in-memory implementation).
// Memory is used rather than sqlite here: same contract, no FFI, and isolation
// via distinct pubKeys (memStorage is a process singleton).
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { kdmBytes, sigBytes, Status } from "../../../shared/consts.ts";
import memStorage from "../../../shared/storage/memory.ts";
import type { IBag, PublicKey } from "../../../shared/types.ts";

function pubKey(tag: number): PublicKey {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    k[i] = (tag + i * 17) & 0xff;
  }
  return k as PublicKey;
}

function bag(n: number, bodyLen = 4): IBag {
  return {
    sig: new Uint8Array(sigBytes).fill(n & 0xff),
    kdm: new Uint8Array(kdmBytes).fill((n + 1) & 0xff),
    headCph: new Uint8Array([n & 0xff, 1, 2, 3]),
    bodyCph: new Uint8Array(bodyLen).fill((n + 2) & 0xff),
  };
}

Deno.test("setBags: empty list", async () => {
  const [seqs, st] = await memStorage.setBags(pubKey(1), []);
  assertEquals(st, Status.Success);
  assertEquals(seqs, []);
});

Deno.test("setBags: assigns contiguous seqs", async () => {
  const pk = pubKey(2);
  const bags = [bag(1), bag(2), bag(3)];
  const [seqs, st] = await memStorage.setBags(pk, bags);
  assertEquals(st, Status.Success);
  assertExists(seqs);
  assertEquals(seqs.length, 3);
  assertEquals(seqs[1], seqs[0] + 1);
  assertEquals(seqs[2], seqs[0] + 2);
});

Deno.test("setBags: continues seq after prior bags", async () => {
  const pk = pubKey(3);
  const [s1, st1] = await memStorage.setBags(pk, [bag(1), bag(2)]);
  assertEquals(st1, Status.Success);
  assertExists(s1);
  const [s2, st2] = await memStorage.setBags(pk, [bag(3)]);
  assertEquals(st2, Status.Success);
  assertExists(s2);
  assertEquals(s2[0], s1[1] + 1);
});

Deno.test("setBags: single bag is a one-element batch", async () => {
  const pk = pubKey(4);
  const b = bag(42, 16);
  const [seqs, st] = await memStorage.setBags(pk, [b]);
  assertEquals(st, Status.Success);
  assertExists(seqs);
  assertEquals(seqs.length, 1);

  const [bodies, stGet] = await memStorage.getBodies(pk, seqs);
  assertEquals(stGet, Status.Success);
  assertExists(bodies);
  assertEquals(bodies.length, 1);
  assertEquals(bodies[0].seq, seqs[0]);
  assertEquals(bodies[0].bodyCph, b.bodyCph);
});

Deno.test("getBodies: empty list", async () => {
  const [bodies, st] = await memStorage.getBodies(pubKey(5), []);
  assertEquals(st, Status.Success);
  assertEquals(bodies, []);
});

Deno.test("getBodies: returns stored bodies and skips missing", async () => {
  const pk = pubKey(6);
  const bags = [bag(10, 8), bag(11, 8), bag(12, 8)];
  const [seqs, stSet] = await memStorage.setBags(pk, bags);
  assertEquals(stSet, Status.Success);
  assertExists(seqs);

  const missing = seqs[2] + 999;
  const [bodies, stGet] = await memStorage.getBodies(pk, [
    seqs[0],
    missing,
    seqs[2],
  ]);
  assertEquals(stGet, Status.Success);
  assertExists(bodies);
  assertEquals(bodies.length, 2);

  const bySeq = new Map(bodies.map((b) => [b.seq, b.bodyCph]));
  assertEquals(bySeq.get(seqs[0]), bags[0].bodyCph);
  assertEquals(bySeq.get(seqs[2]), bags[2].bodyCph);
  assertEquals(bySeq.has(missing), false);
  assertEquals(bySeq.has(seqs[1]), false);
});

Deno.test("getBodies: large batch (multi-chunk host bind budget)", async () => {
  // Hosts chunk IN (...) at 99 seqs (100 binds − userPubKey). Exercise a
  // larger list so any future SQL backend test can reuse this case.
  const pk = pubKey(7);
  const n = 150;
  const bags = Array.from({ length: n }, (_, i) => bag(i, 2));
  const [seqs, stSet] = await memStorage.setBags(pk, bags);
  assertEquals(stSet, Status.Success);
  assertExists(seqs);
  assertEquals(seqs.length, n);

  const [bodies, stGet] = await memStorage.getBodies(pk, seqs);
  assertEquals(stGet, Status.Success);
  assertExists(bodies);
  assertEquals(bodies.length, n);

  const bySeq = new Map(bodies.map((b) => [b.seq, b.bodyCph]));
  for (let i = 0; i < n; i++) {
    assertEquals(bySeq.get(seqs[i]), bags[i].bodyCph);
  }
});

Deno.test("getBodies: unknown user is empty", async () => {
  const [bodies, st] = await memStorage.getBodies(pubKey(8), [1, 2, 3]);
  assertEquals(st, Status.Success);
  assertEquals(bodies, []);
});
