// Checks that a 0.22 passkey seal opens with the old concat key.

import { describe, expect, test } from "vitest";
import crypto from "../src/crypto";
import { bytesEqual, concat } from "../src/shared/binary";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { unseal022 } from "../src/stores/idb/copy022";

const DOMAIN = new TextEncoder().encode("diplomatic.bind.v1");

// Seals `seed` the way the 0.22 client did: blake3(prf ‖ domain) as the key.
async function seal022(seed: Uint8Array, prf: Uint8Array): Promise<Uint8Array> {
  const mix = concat(prf, DOMAIN);
  const hash = await crypto.blake3(mix);
  const key = hash.slice(0, 32);
  try {
    return await crypto.encryptXSalsa20Poly1305Combined(seed, key);
  } finally {
    mix.fill(0);
    hash.fill(0);
    key.fill(0);
  }
}

describe("unseal022", () => {
  test("opens a 0.22 seal", async () => {
    const seed = new Uint8Array(32).fill(7);
    const prf = new Uint8Array(32).fill(9);
    const sealed = await seal022(seed, prf);
    const [opened, st] = await unseal022(crypto, sealed, prf);
    if (st !== Status.Success) throw new Error(String(st));
    const [want, wst] = Enclave.fromBytes(seed);
    if (wst !== Status.Success) throw new Error(String(wst));
    const [got, gst] = await opened.fingerprint();
    const [exp, est] = await want.fingerprint();
    if (gst !== Status.Success || est !== Status.Success) {
      throw new Error("fingerprint");
    }
    expect(bytesEqual(got, exp)).toBe(true);
    prf.fill(0);
    seed.fill(0);
  });

  test("a wrong prf is DecryptionError", async () => {
    const seed = new Uint8Array(32).fill(7);
    const prf = new Uint8Array(32).fill(9);
    const sealed = await seal022(seed, prf);
    const [, st] = await unseal022(crypto, sealed, new Uint8Array(32).fill(8));
    expect(st).toBe(Status.DecryptionError);
  });

  test("a short prf or a short seal is InvalidParam", async () => {
    const prf = new Uint8Array(32).fill(9);
    const shortPrf = await unseal022(
      crypto,
      new Uint8Array(72),
      new Uint8Array(15),
    );
    const shortSeal = await unseal022(crypto, new Uint8Array(8), prf);
    expect(shortPrf[1]).toBe(Status.InvalidParam);
    expect(shortSeal[1]).toBe(Status.InvalidParam);
  });
});
