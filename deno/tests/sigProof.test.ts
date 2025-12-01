// Deno test file for sigProof functions

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  encodeSigProvenData,
  decodeSigProvenData,
  type ISigProvenData,
} from "../../shared/sigProof.ts";
import { uint8ArraysEqual } from "../../shared/lib.ts";

// function uint8ArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
//   if (a.length !== b.length) return false;
//   for (let i = 0; i < a.length; i++) {
//     if (a[i] !== b[i]) return false;
//   }
//   return true;
// }

Deno.test("encodeSigProvenData and decodeSigProvenData round-trip", () => {
  const spdata: ISigProvenData = {
    keyPath: "testpath",
    idx: 42,
    pubKey: new Uint8Array(32).fill(1),
    sig: new Uint8Array(64).fill(2),
    data: new Uint8Array([3, 4, 5]),
  };

  const dummyCrypto = {} as any; // crypto not used in encode/decode
  const encoded = encodeSigProvenData(spdata, dummyCrypto);
  const decoded = decodeSigProvenData(encoded);

  assertEquals(decoded.keyPath, spdata.keyPath);
  assertEquals(decoded.idx, spdata.idx);
  assertEquals(uint8ArraysEqual(decoded.pubKey, spdata.pubKey), true);
  assertEquals(uint8ArraysEqual(decoded.sig, spdata.sig), true);
  assertEquals(uint8ArraysEqual(decoded.data, spdata.data), true);
});

Deno.test("encodeSigProvenData with keyPath longer than 8 chars", () => {
  const spdata: ISigProvenData = {
    keyPath: "verylongpath",
    idx: 123,
    pubKey: new Uint8Array(32).fill(5),
    sig: new Uint8Array(64).fill(6),
    data: new Uint8Array([7, 8]),
  };

  const dummyCrypto = {} as any;
  const encoded = encodeSigProvenData(spdata, dummyCrypto);
  const decoded = decodeSigProvenData(encoded);

  assertEquals(decoded.keyPath, "verylong"); // truncated to 8 chars
  assertEquals(decoded.idx, 123);
  assertEquals(uint8ArraysEqual(decoded.pubKey, spdata.pubKey), true);
  assertEquals(uint8ArraysEqual(decoded.sig, spdata.sig), true);
  assertEquals(uint8ArraysEqual(decoded.data, spdata.data), true);
});

Deno.test("encodeSigProvenData with keyPath shorter than 8 chars", () => {
  const spdata: ISigProvenData = {
    keyPath: "short",
    idx: 0,
    pubKey: new Uint8Array(32).fill(9),
    sig: new Uint8Array(64).fill(10),
    data: new Uint8Array([]), // empty data
  };

  const dummyCrypto = {} as any;
  const encoded = encodeSigProvenData(spdata, dummyCrypto);
  const decoded = decodeSigProvenData(encoded);

  assertEquals(decoded.keyPath, "short"); // trailing nulls trimmed
  assertEquals(decoded.idx, 0);
  assertEquals(uint8ArraysEqual(decoded.pubKey, spdata.pubKey), true);
  assertEquals(uint8ArraysEqual(decoded.sig, spdata.sig), true);
  assertEquals(uint8ArraysEqual(decoded.data, spdata.data), true);
});

Deno.test("decodeSigProvenData with invalid data length", () => {
  const shortEncoded = new Uint8Array(100); // less than 112
  try {
    decodeSigProvenData(shortEncoded);
    throw new Error("Should have thrown");
  } catch (e) {
    assertEquals((e as Error).message, "Encoded data too short");
  }
});
