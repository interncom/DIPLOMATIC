import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Status } from "../../shared/consts.ts";
import { asMasterSeed, Enclave } from "../../shared/crypto/enclave.ts";
import { NobleCrypto } from "../../shared/crypto/noble.ts";
import {
  asDHKEReq,
  asDHKEResp,
  DHKE_RESP_MIN,
  pairKey,
  PairRequest,
  X25519_PUB_LEN,
} from "../../shared/crypto/pairing.ts";

function seedOf(fill: number) {
  const [s, st] = asMasterSeed(new Uint8Array(32).fill(fill));
  if (st !== Status.Success || s === undefined) throw new Error(`seed ${st}`);
  return s;
}

function encOf(fill: number) {
  const [e, st] = Enclave.fromBytes(seedOf(fill));
  if (st !== Status.Success || e === undefined) throw new Error(`enc ${st}`);
  return e;
}

async function reqOf() {
  const [r, st] = await PairRequest.create();
  if (st !== Status.Success || r === undefined) throw new Error(`req ${st}`);
  return r;
}

function brandReq(bytes: Uint8Array) {
  const [q, st] = asDHKEReq(bytes);
  if (st !== Status.Success || q === undefined) throw new Error(`req ${st}`);
  return q;
}

Deno.test("asDHKEReq brands 32 B only", () => {
  const [ok32, s32] = asDHKEReq(new Uint8Array(X25519_PUB_LEN));
  assertEquals(s32, Status.Success);
  assert(ok32 !== undefined);
  assertEquals(ok32.byteLength, X25519_PUB_LEN);
  for (const n of [0, 16, 31, 33]) {
    const [, st] = asDHKEReq(new Uint8Array(n));
    assertEquals(st, Status.InvalidParam);
  }
});

Deno.test("asDHKEResp brands >= DHKE_RESP_MIN", () => {
  const [okMin, sMin] = asDHKEResp(new Uint8Array(DHKE_RESP_MIN));
  assertEquals(sMin, Status.Success);
  assert(okMin !== undefined);
  const [okMore, sMore] = asDHKEResp(new Uint8Array(DHKE_RESP_MIN + 8));
  assertEquals(sMore, Status.Success);
  assert(okMore !== undefined);
  const [, sShort] = asDHKEResp(new Uint8Array(DHKE_RESP_MIN - 1));
  assertEquals(sShort, Status.InvalidParam);
});

Deno.test("dhkeReq getter is a copy", async () => {
  const req = await reqOf();
  const a = req.dhkeReq;
  const b = req.dhkeReq;
  assertEquals(a, b);
  assert(a !== b);
  a.fill(0);
  assertEquals(req.dhkeReq, b);
});

Deno.test("pairKey agrees; binds both pubs", async () => {
  const n = new NobleCrypto();
  const e = await n.genX25519();
  const r = await n.genX25519();
  const [k1, s1] = await pairKey(e.priv, r.pub, e.pub, r.pub);
  const [k2, s2] = await pairKey(r.priv, e.pub, e.pub, r.pub);
  assertEquals(s1, Status.Success);
  assertEquals(s2, Status.Success);
  assert(k1 !== undefined && k2 !== undefined);
  assertEquals(k1, k2);
  assertEquals(k1.byteLength, 32);
  const [swapped, sst] = await pairKey(e.priv, r.pub, r.pub, e.pub);
  assertEquals(sst, Status.Success);
  assert(swapped !== undefined);
  assert(k1.some((b, i) => b !== swapped[i]));
});

Deno.test("pairKey rejects a short peer pub", async () => {
  const n = new NobleCrypto();
  const e = await n.genX25519();
  const [k, st] = await pairKey(e.priv, new Uint8Array(16), e.pub, e.pub);
  assertEquals(st, Status.CryptoError);
  assertEquals(k, undefined);
});

Deno.test("pairKey rejects an all-zero peer pub", async () => {
  const n = new NobleCrypto();
  const e = await n.genX25519();
  const [k, st] = await pairKey(e.priv, new Uint8Array(32), e.pub, e.pub);
  assert(st !== Status.Success);
  assertEquals(k, undefined);
});

Deno.test("DHKE round-trips seed and hosts", async () => {
  const enc = encOf(8);
  const hosts = [
    { handle: "https://sync.interncom.org", label: "host", idx: 0 },
    { handle: "https://b.example.com", label: "backup", idx: 1 },
  ];
  const req = await reqOf();
  assertEquals(req.dhkeReq.byteLength, X25519_PUB_LEN);
  const [resp, ast] = await enc.pairAccept(req.dhkeReq, hosts);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  assert(resp.byteLength > DHKE_RESP_MIN);
  const [opened, ost] = await req.finish(resp);
  assertEquals(ost, Status.Success);
  assert(opened !== undefined);
  assertEquals(opened.hosts, hosts);
  const a = await enc.deriveIdentity("test", 0);
  const b = await opened.enclave.deriveIdentity("test", 0);
  assertEquals(b.publicKey, a.publicKey);
});

Deno.test("DHKE empty hosts", async () => {
  const enc = encOf(3);
  const [req, cst] = await Enclave.pairRequest();
  assertEquals(cst, Status.Success);
  assert(req !== undefined);
  const [resp, ast] = await enc.pairAccept(req.dhkeReq, []);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  const [opened, ost] = await req.finish(resp);
  assertEquals(ost, Status.Success);
  assertEquals(opened?.hosts, []);
});

Deno.test("finish after mutating getter copy still works", async () => {
  const enc = encOf(4);
  const req = await reqOf();
  const shown = req.dhkeReq;
  const [resp, ast] = await enc.pairAccept(shown, []);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  shown.fill(0);
  const [opened, ost] = await req.finish(resp);
  assertEquals(ost, Status.Success);
  assert(opened !== undefined);
});

Deno.test("wrong PairRequest cannot finish", async () => {
  const [resp, ast] = await encOf(1).pairAccept((await reqOf()).dhkeReq, []);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  const [, ost] = await (await reqOf()).finish(resp);
  assertEquals(ost, Status.DecryptionError);
});

Deno.test("tampered resp body fails closed", async () => {
  const req = await reqOf();
  const [resp, ast] = await encOf(2).pairAccept(req.dhkeReq, []);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  const dirty = resp.slice();
  dirty[dirty.byteLength - 1] ^= 1;
  const [branded, bst] = asDHKEResp(dirty);
  assertEquals(bst, Status.Success);
  assert(branded !== undefined);
  const [, ost] = await req.finish(branded);
  assertEquals(ost, Status.DecryptionError);
});

Deno.test("tampered respPub fails closed", async () => {
  const req = await reqOf();
  const [resp, ast] = await encOf(5).pairAccept(req.dhkeReq, []);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  const dirty = resp.slice();
  dirty[0] ^= 1;
  const [branded, bst] = asDHKEResp(dirty);
  assertEquals(bst, Status.Success);
  assert(branded !== undefined);
  const [, ost] = await req.finish(branded);
  assert(ost !== Status.Success);
});

Deno.test("finish wipes priv (second finish fails)", async () => {
  const req = await reqOf();
  const [resp, ast] = await encOf(6).pairAccept(req.dhkeReq, []);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  const [opened, ost] = await req.finish(resp);
  assertEquals(ost, Status.Success);
  assert(opened !== undefined);
  const [, ost2] = await req.finish(resp);
  assertEquals(ost2, Status.DecryptionError);
});

Deno.test("wipe abandons the session", async () => {
  const req = await reqOf();
  const [resp, ast] = await encOf(8).pairAccept(req.dhkeReq, []);
  assertEquals(ast, Status.Success);
  assert(resp !== undefined);
  req.wipe();
  req.wipe();
  const [, ost] = await req.finish(resp);
  assertEquals(ost, Status.DecryptionError);
});

Deno.test("pairAccept rejects an all-zero enrollee pub", async () => {
  const [, ast] = await encOf(7).pairAccept(brandReq(new Uint8Array(32)), []);
  assert(ast !== Status.Success);
});
