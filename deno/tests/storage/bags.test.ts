// Unit tests for IStorage.setBags / getBodies (in-memory implementation).
// Memory is used rather than sqlite here: same contract, no FFI, and isolation
// via distinct pubKeys (memStorage is a process singleton).
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { kdmBytes, sigBytes, Status } from "../../../shared/consts.ts";
import { asHostRlm, type HostRlm } from "../../../shared/crypto/derivation.ts";
import memStorage from "../../../shared/storage/memory.ts";
import type { IBag, ISetBagResult, PublicKey } from "../../../shared/types.ts";

function pubKey(tag: number): PublicKey {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    k[i] = (tag + i * 17) & 0xff;
  }
  return k as PublicKey;
}

function rlmOf(realm: number): HostRlm {
  const [rlm, st] = asHostRlm(new Uint8Array(32).fill(realm & 0xff));
  if (st !== Status.Success) throw new Error(`rlm ${st}`);
  return rlm;
}

function seqOf(row: ISetBagResult | undefined): number {
  if (row === undefined || row.status !== Status.Success) {
    throw new Error("seq");
  }
  return row.seq;
}

function seqsOf(rows: ISetBagResult[] | undefined): number[] {
  if (rows === undefined) throw new Error("rows");
  return rows.map((row) => seqOf(row));
}

function bag(n: number, bodyLen = 4, realm = 1): IBag {
  return {
    rlm: rlmOf(realm),
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
  const seqsN = seqsOf(seqs);
  assertEquals(seqsN.length, 3);
  assertEquals(seqsN[1], seqsN[0] + 1);
  assertEquals(seqsN[2], seqsN[0] + 2);
});

Deno.test("setBags: seq is per rlm", async () => {
  const pk = pubKey(9);
  const [seqs, st] = await memStorage.setBags(pk, [
    bag(1, 4, 1),
    bag(2, 4, 2),
    bag(3, 4, 1),
  ]);
  assertEquals(st, Status.Success);
  assertEquals(seqsOf(seqs), [1, 1, 2]);
  const r1 = rlmOf(1);
  const r2 = rlmOf(2);
  const [h1, s1] = await memStorage.listHeads(pk, r1, 0);
  const [h2, s2] = await memStorage.listHeads(pk, r2, 0);
  if (s1 !== Status.Success || s2 !== Status.Success) {
    assertEquals(s1, Status.Success);
    return;
  }
  assertEquals(h1.map((h) => h.seq), [1, 2]);
  assertEquals(h2.map((h) => h.seq), [1]);
  const [b1, sb1] = await memStorage.getBodies(pk, r1, [1]);
  const [b2, sb2] = await memStorage.getBodies(pk, r2, [1]);
  if (sb1 !== Status.Success || sb2 !== Status.Success) {
    assertEquals(sb1, Status.Success);
    return;
  }
  assertEquals(b1.map((b) => b.bodyCph[0]), [(1 + 2) & 0xff]);
  assertEquals(b2.map((b) => b.bodyCph[0]), [(2 + 2) & 0xff]);
});

Deno.test("setBags: continues seq after prior bags", async () => {
  const pk = pubKey(3);
  const [s1, st1] = await memStorage.setBags(pk, [bag(1), bag(2)]);
  assertEquals(st1, Status.Success);
  assertExists(s1);
  const [s2, st2] = await memStorage.setBags(pk, [bag(3)]);
  assertEquals(st2, Status.Success);
  assertExists(s2);
  assertEquals(seqOf(s2[0]), seqOf(s1[1]) + 1);
});

Deno.test("setBags: single bag is a one-element batch", async () => {
  const pk = pubKey(4);
  const b = bag(42, 16);
  const [seqs, st] = await memStorage.setBags(pk, [b]);
  assertEquals(st, Status.Success);
  assertExists(seqs);
  assertEquals(seqs.length, 1);

  const seqsN = seqsOf(seqs);
  const [bodies, stGet] = await memStorage.getBodies(pk, rlmOf(1), seqsN);
  assertEquals(stGet, Status.Success);
  assertExists(bodies);
  assertEquals(bodies.length, 1);
  assertEquals(bodies[0].seq, seqsN[0]);
  assertEquals(bodies[0].bodyCph, b.bodyCph);
});

Deno.test("setBags: invalid rlm does not drop the rest", async () => {
  const pk = pubKey(10);
  const bad = bag(2);
  bad.rlm = new Uint8Array(3) as HostRlm;
  const [rows, st] = await memStorage.setBags(pk, [bag(1), bad, bag(3)]);
  assertEquals(st, Status.Success);
  assertExists(rows);
  assertEquals(rows[1]?.status, Status.InvalidParam);
  const seqsN = [seqOf(rows[0]), seqOf(rows[2])];
  assertEquals(seqsN[1], seqsN[0] + 1);
  const [heads, hs] = await memStorage.listHeads(pk, rlmOf(1), 0);
  assertEquals(hs, Status.Success);
  assertEquals(heads?.map((h) => h.seq), seqsN);
});

Deno.test("getBodies: empty list", async () => {
  const [bodies, st] = await memStorage.getBodies(pubKey(5), rlmOf(1), []);
  assertEquals(st, Status.Success);
  assertEquals(bodies, []);
});

Deno.test("getBodies: returns stored bodies and skips missing", async () => {
  const pk = pubKey(6);
  const bags = [bag(10, 8), bag(11, 8), bag(12, 8)];
  const [seqs, stSet] = await memStorage.setBags(pk, bags);
  assertEquals(stSet, Status.Success);
  assertExists(seqs);

  const seqsN = seqsOf(seqs);
  const missing = seqsN[2] + 999;
  const [bodies, stGet] = await memStorage.getBodies(pk, rlmOf(1), [
    seqsN[0],
    missing,
    seqsN[2],
  ]);
  assertEquals(stGet, Status.Success);
  assertExists(bodies);
  assertEquals(bodies.length, 2);

  const bySeq = new Map(bodies.map((b) => [b.seq, b.bodyCph]));
  assertEquals(bySeq.get(seqsN[0]), bags[0].bodyCph);
  assertEquals(bySeq.get(seqsN[2]), bags[2].bodyCph);
  assertEquals(bySeq.has(missing), false);
  assertEquals(bySeq.has(seqs[1]), false);
});

Deno.test("getBodies: large batch (multi-chunk host bind budget)", async () => {
  // Hosts chunk IN (...) at 98 seqs (100 binds − userPubKey − rlm). Exercise
  // a larger list so any future SQL backend test can reuse this case.
  const pk = pubKey(7);
  const n = 150;
  const bags = Array.from({ length: n }, (_, i) => bag(i, 2));
  const [seqs, stSet] = await memStorage.setBags(pk, bags);
  assertEquals(stSet, Status.Success);
  assertExists(seqs);
  const seqsN = seqsOf(seqs);
  assertEquals(seqsN.length, n);

  const [bodies, stGet] = await memStorage.getBodies(pk, rlmOf(1), seqsN);
  assertEquals(stGet, Status.Success);
  assertExists(bodies);
  assertEquals(bodies.length, n);

  const bySeq = new Map(bodies.map((b) => [b.seq, b.bodyCph]));
  for (let i = 0; i < n; i++) {
    assertEquals(bySeq.get(seqsN[i]), bags[i].bodyCph);
  }
});

Deno.test("getBodies: unknown user is empty", async () => {
  const [bodies, st] = await memStorage.getBodies(pubKey(8), rlmOf(1), [
    1,
    2,
    3,
  ]);
  assertEquals(st, Status.Success);
  assertEquals(bodies, []);
});
