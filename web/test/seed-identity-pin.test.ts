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

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(new Uint8Array(32).fill(fill));
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclaveOf ${st}`);
  }
  return e;
}

describe("MemorySeedStore identity pin", () => {
  test("first save pins; same seed ok; different seed rejected", async () => {
    const store = new MemorySeedStore(crypto);
    await store.save(enclaveOf(1));
    await store.save(enclaveOf(1)); // same master
    await expect(store.save(enclaveOf(2))).rejects.toThrow(
      /does not match this device's identity/,
    );
  });

  test("wipe clears pin so a new seed can be installed", async () => {
    const store = new MemorySeedStore(crypto);
    await store.save(enclaveOf(3));
    await store.wipe();
    await store.save(enclaveOf(9));
    await store.save(enclaveOf(9));
  });

  test("durable pin is nonce+hash, not a host public key", async () => {
    const store = new MemorySeedStore(crypto);
    const enc = enclaveOf(5);
    await store.save(enc);
    const pin = store.peekPin();
    expect(pin).toBeDefined();
    if (pin === undefined) return;
    expect(pin.n.byteLength).toBe(32);
    expect(pin.h.byteLength).toBe(32);
    const pathPub = (await enc.deriveIdentity(idPinPath(pin.n), 0)).publicKey;
    const hostPub = (await enc.deriveIdentity("host", 0)).publicKey;
    expect(pin.h).not.toEqual(pathPub);
    expect(pin.h).not.toEqual(hostPub);
    expect(await idPinDigest(crypto, enc, pin.n)).toEqual(pin.h);
  });

  test("same seed + different nonces → uncorrelated pin digests", async () => {
    const enc = enclaveOf(7);
    const a = await makeIdPin(crypto, enc);
    const b = await makeIdPin(crypto, enc);
    expect(a.n).not.toEqual(b.n);
    expect(a.h).not.toEqual(b.h);
    // Each pin still verifies against the same enclave.
    expect(await idPinDigest(crypto, enc, a.n)).toEqual(a.h);
    expect(await idPinDigest(crypto, enc, b.n)).toEqual(b.h);
  });
});
