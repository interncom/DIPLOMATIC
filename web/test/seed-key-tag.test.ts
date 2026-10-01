import { describe, expect, test } from "vitest";
import crypto from "../src/crypto";
import { btoh } from "../src/shared/binary";
import { Enclave } from "../src/shared/crypto/enclave";
import { Status } from "../src/shared/consts";
import { keyTagDigest, keyTagMatches, makeKeyTag } from "../src/stores/keyTag";
import { MemoryAccountStore } from "../src/stores/memory/account";
import { mustIdnt } from "./mustIdnt";

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(new Uint8Array(32).fill(fill));
  if (st !== Status.Success) {
    throw new Error(`enclaveOf ${st}`);
  }
  return e;
}

describe("MemoryAccountStore key tag", () => {
  test("first save writes a key tag; same seed ok; different seed rejected", async () => {
    const store = new MemoryAccountStore(crypto);
    const [a, ast] = await store.save(enclaveOf(1));
    const [, same] = await store.save(enclaveOf(1)); // same master
    const [, bad] = await store.save(enclaveOf(2));
    expect(ast).toBe(Status.Success);
    expect(a).toBeDefined();
    expect(same).toBe(Status.Success);
    expect(bad).toBe(Status.HashMismatch);
  });

  test("a different label is a different account", async () => {
    const store = new MemoryAccountStore(crypto);
    expect((await store.save(enclaveOf(1)))[1]).toBe(Status.Success);
    expect((await store.save(enclaveOf(2), { label: "work" }))[1]).toBe(
      Status.Success,
    );
    expect((await store.save(enclaveOf(2)))[1]).toBe(Status.HashMismatch);
    expect((await store.save(enclaveOf(1), { label: "work" }))[1]).toBe(
      Status.HashMismatch,
    );
    expect((await store.save(enclaveOf(2), { label: "work" }))[1]).toBe(
      Status.Success,
    );
  });

  test("wipe clears the key tag so a new seed can be installed", async () => {
    const store = new MemoryAccountStore(crypto);
    expect((await store.save(enclaveOf(3)))[1]).toBe(Status.Success);
    await store.wipe();
    expect((await store.save(enclaveOf(9)))[1]).toBe(Status.Success);
    expect((await store.save(enclaveOf(9)))[1]).toBe(Status.Success);
  });

  test("durable key tag is a fingerprint child, not a host public key", async () => {
    const store = new MemoryAccountStore(crypto);
    const enc = enclaveOf(5);
    expect((await store.save(enc))[1]).toBe(Status.Success);
    const tag = store.peekKeyTag();
    expect(tag).toBeDefined();
    if (tag === undefined) return;
    expect(tag.n.byteLength).toBe(32);
    expect(tag.h.byteLength).toBe(32);
    const hostPub = (await mustIdnt(enc, "host", 0)).publicKey;
    const [child, cst] = await enc.fingerprint(tag.n);
    const [paper, pst] = await enc.fingerprint();
    expect(cst).toBe(Status.Success);
    expect(pst).toBe(Status.Success);
    expect(tag.h).toEqual(child);
    expect(tag.h).not.toEqual(hostPub);
    expect(tag.h).not.toEqual(paper);
    const [dig, dst] = await keyTagDigest(enc, tag.n);
    expect(dst).toBe(Status.Success);
    expect(dig).toEqual(tag.h);
  });

  test("same seed + different nonces → uncorrelated key tags", async () => {
    const enc = enclaveOf(7);
    const [a, ast] = await makeKeyTag(crypto, enc);
    const [b, bst] = await makeKeyTag(crypto, enc);
    expect(ast).toBe(Status.Success);
    expect(bst).toBe(Status.Success);
    if (a === undefined || b === undefined) return;
    expect(a.n).not.toEqual(b.n);
    expect(a.h).not.toEqual(b.h);
    const [ah, ahst] = await keyTagDigest(enc, a.n);
    const [bh, bhst] = await keyTagDigest(enc, b.n);
    expect(ahst).toBe(Status.Success);
    expect(bhst).toBe(Status.Success);
    expect(ah).toEqual(a.h);
    expect(bh).toEqual(b.h);
  });

  // TODO(accounts-sunset): pubkey-hash rows still match and rewrite.
  test("legacy key tag matches and rewrites to the fingerprint child", async () => {
    const enc = enclaveOf(4);
    const n = new Uint8Array(32).fill(9);
    const [idnt, ist] = await enc.deriveIdentity({
      label: "diplomatic.pin/" + btoh(n),
      index: 0,
    });
    expect(ist).toBe(Status.Success);
    if (idnt === undefined) return;
    const old = await crypto.blake3(idnt.publicKey);
    const hit = await keyTagMatches(crypto, enc, { n, h: old });
    expect(hit.ok).toBe(true);
    if (!hit.ok || hit.next === undefined) return;
    expect(hit.next.n).toEqual(n);
    expect(hit.next.h).not.toEqual(old);
    const [child, cst] = await enc.fingerprint(n);
    expect(cst).toBe(Status.Success);
    expect(hit.next.h).toEqual(child);
  });
});
