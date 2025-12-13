// Deno test file for sigProof functions

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  encodeSigProvenData,
  decodeSigProvenData,
  sigProof,
  type ISigProvenData,
} from "../../shared/sigProof.ts";
import { uint8ArraysEqual, btoh } from "../../shared/lib.ts";
import libsodiumCrypto from "../src/crypto.ts";

// function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
//   if (a.length !== b.length) return false;
//   for (let i = 0; i < a.length; i++) {
//     if (a[i] !== b[i]) return false;
//   }
//   return true;
// }

Deno.test(
  "encodeSigProvenData and decodeSigProvenData round-trip with real crypto",
  async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const data = new Uint8Array([3, 4, 5]);
    const sigProofResult = await sigProof(
      seed,
      "testpath",
      42,
      data,
      libsodiumCrypto,
    );
    const spdata: ISigProvenData = {
      ...sigProofResult,
      data,
    };

    const encoded = encodeSigProvenData(spdata, libsodiumCrypto);
    const decoded = decodeSigProvenData(encoded);

    assertEquals(uint8ArraysEqual(decoded.pubKey, spdata.pubKey), true);
    assertEquals(uint8ArraysEqual(decoded.sig, spdata.sig), true);
    assertEquals(uint8ArraysEqual(decoded.data, spdata.data), true);
  },
);

Deno.test(
  "encodeSigProvenData with keyPath longer than 8 chars and real crypto",
  async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const data = new Uint8Array([7, 8]);
    const sigProofResult = await sigProof(
      seed,
      "verylongpath",
      123,
      data,
      libsodiumCrypto,
    );
    const spdata: ISigProvenData = {
      ...sigProofResult,
      data,
    };

    const encoded = encodeSigProvenData(spdata, libsodiumCrypto);
    const decoded = decodeSigProvenData(encoded);

    assertEquals(uint8ArraysEqual(decoded.pubKey, spdata.pubKey), true);
    assertEquals(uint8ArraysEqual(decoded.sig, spdata.sig), true);
    assertEquals(uint8ArraysEqual(decoded.data, spdata.data), true);
  },
);

Deno.test(
  "encodeSigProvenData with keyPath shorter than 8 chars and real crypto",
  async () => {
    const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
    const data = new Uint8Array([]); // empty data
    const sigProofResult = await sigProof(
      seed,
      "short",
      0,
      data,
      libsodiumCrypto,
    );
    const spdata: ISigProvenData = {
      ...sigProofResult,
      data,
    };

    const encoded = encodeSigProvenData(spdata, libsodiumCrypto);
    const decoded = decodeSigProvenData(encoded);

    assertEquals(uint8ArraysEqual(decoded.pubKey, spdata.pubKey), true);
    assertEquals(uint8ArraysEqual(decoded.sig, spdata.sig), true);
    assertEquals(uint8ArraysEqual(decoded.data, spdata.data), true);
  },
);

Deno.test("decodeSigProvenData with invalid data length", () => {
  const shortEncoded = new Uint8Array(90); // less than 96
  try {
    decodeSigProvenData(shortEncoded);
    throw new Error("Should have thrown");
  } catch (e) {
    assertEquals((e as Error).message, "Encoded data too short");
  }
});
