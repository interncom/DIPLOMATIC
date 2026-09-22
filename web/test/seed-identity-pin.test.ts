import { describe, expect, test } from "vitest";
import crypto from "../src/crypto";
import { Enclave } from "../src/shared/crypto/enclave";
import { Status } from "../src/shared/consts";
import {
  idPinDigest,
  idPinPath,
  makeIdPin,
} from "../src/stores/identityPin";
import { MemorySeedStore } from "../src/stores/memory/seed";
import { mustIdnt } from "./mustIdnt";

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(new Uint8Array(32).fill(fill));
  if (st !== Status.Success) {
    throw new Error(`enclaveOf ${st}`);
  }
  return e;
}

describe("MemorySeedStore identity pin", () => {
  test("first save pins; same seed ok; different seed rejected", async () => {
    const store = new MemorySeedStore(crypto);
    const [a, ast] = await store.save(enclaveOf(1));
    const [, same] = await store.save(enclaveOf(1)); // same master
    const [, bad] = await store.save(enclaveOf(2));
    expect(ast).toBe(Status.Success);
    expect(a).toBeDefined();
    expect(same).toBe(Status.Success);
    expect(bad).toBe(Status.HashMismatch);
  });

  test("wipe clears pin so a new seed can be installed", async () => {
    const store = new MemorySeedStore(crypto);
    expect((await store.save(enclaveOf(3)))[1]).toBe(Status.Success);
    await store.wipe();
    expect((await store.save(enclaveOf(9)))[1]).toBe(Status.Success);
    expect((await store.save(enclaveOf(9)))[1]).toBe(Status.Success);
  });

  test("durable pin is nonce+hash, not a host public key", async () => {
    const store = new MemorySeedStore(crypto);
    const enc = enclaveOf(5);
    expect((await store.save(enc))[1]).toBe(Status.Success);
    const pin = store.peekPin();
    expect(pin).toBeDefined();
    if (pin === undefined) return;
    expect(pin.n.byteLength).toBe(32);
    expect(pin.h.byteLength).toBe(32);
    const pathPub = (await mustIdnt(enc, idPinPath(pin.n), 0)).publicKey;
    const hostPub = (await mustIdnt(enc, "host", 0)).publicKey;
    expect(pin.h).not.toEqual(pathPub);
    expect(pin.h).not.toEqual(hostPub);
    const [dig] = await idPinDigest(crypto, enc, pin.n);
    expect(dig).toEqual(pin.h);
  });

  test("same seed + different nonces → uncorrelated pin digests", async () => {
    const enc = enclaveOf(7);
    const [a, ast] = await makeIdPin(crypto, enc);
    const [b, bst] = await makeIdPin(crypto, enc);
    expect(ast).toBe(Status.Success);
    expect(bst).toBe(Status.Success);
    expect(a.n).not.toEqual(b.n);
    expect(a.h).not.toEqual(b.h);
    // Each pin still verifies against the same enclave.
    const [ah] = await idPinDigest(crypto, enc, a.n);
    const [bh] = await idPinDigest(crypto, enc, b.n);
    expect(ah).toEqual(a.h);
    expect(bh).toEqual(b.h);
  });
});
