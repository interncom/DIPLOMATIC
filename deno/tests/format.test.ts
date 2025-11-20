import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import {
  encodeOpForHost,
  formOpForHost,
  encryptOp,
} from "../../web/src/shared/format.ts";
import libsodiumCrypto from "../src/crypto.ts";

const idxBytes = 4;
const sigBytes = 64;
const shaBytes = 32;
const lenBytes = 8;
const keyPathBytes = 8;
const eidBytes = 16;
const clkBytes = 8;
const ctrBytes = 4;

// Helper functions for converting to big-endian bytes
function dateToBytes(date: Date): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, BigInt(date.getTime()), false);
  return new Uint8Array(buffer);
}

function numberTo4Bytes(num: number): Uint8Array {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setUint32(0, num, false);
  return new Uint8Array(buffer);
}

function numberTo8Bytes(num: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, BigInt(num), false);
  return new Uint8Array(buffer);
}

Deno.test("format", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("encryptOp", async () => {
    const op = {
      eid: new Uint8Array(16).fill(0x11),
      clk: new Date(1234567890000),
      ctr: 42,
      body: new Uint8Array([1, 2, 3]),
    };
    const result = await encryptOp(op, crypto);
    // Build expected manually (assuming SHA is fixed for test)
    const expectedLen = op.body.length;
    const expectedSha = await crypto.sha256Hash(op.body);
    const expectedCipher = new Uint8Array(
      eidBytes + clkBytes + ctrBytes + shaBytes + lenBytes + expectedLen,
    );
    const view = new DataView(expectedCipher.buffer, expectedCipher.byteOffset);
    expectedCipher.set(op.eid, 0);
    view.setBigUint64(eidBytes, BigInt(op.clk.getTime()), false);
    view.setUint32(eidBytes + clkBytes, op.ctr, false);
    expectedCipher.set(expectedSha, eidBytes + clkBytes + ctrBytes);
    view.setBigUint64(
      eidBytes + clkBytes + ctrBytes + shaBytes,
      BigInt(expectedLen),
      false,
    );
    expectedCipher.set(
      op.body,
      eidBytes + clkBytes + ctrBytes + shaBytes + lenBytes,
    );
    assertEquals(result, expectedCipher);
  });

  await t.step("formOpForHost", async () => {
    const cipherOp = new Uint8Array([4, 5, 6]);
    const keyPair = {
      keyType: "private" as const,
      privateKey: new Uint8Array(64).fill(0x22),
      publicKey: new Uint8Array(32).fill(0x33),
    };
    const result = await formOpForHost(keyPair, cipherOp, crypto);
    // Compute expected values
    const len = keyPathBytes + cipherOp.length;
    const hashSrc = new Uint8Array(len);
    hashSrc.set(new Uint8Array(8).fill(0), 0); // keyPath
    hashSrc.set(cipherOp, 8);
    const expectedHash = await crypto.sha256Hash(hashSrc);
    const expectedSig = await crypto.signEd25519(
      expectedHash,
      keyPair.privateKey,
    );
    assertEquals(result.sig, expectedSig);
    assertEquals(result.hash, expectedHash);
    assertEquals(result.len, len);
    assertEquals(result.cipherOp, cipherOp);
  });

  await t.step("encodeOpForHost", async () => {
    const idx = 5;
    const op = {
      sig: new Uint8Array(64).fill(0x77),
      hash: new Uint8Array(32).fill(0x88),
      len: 99,
      cipherOp: new Uint8Array([10, 11, 12]),
    };
    const result = await encodeOpForHost(idx, op);
    // Expected
    const expected = new Uint8Array(
      idxBytes + sigBytes + shaBytes + lenBytes + op.cipherOp.length,
    );
    const view = new DataView(expected.buffer, expected.byteOffset);
    view.setUint32(0, idx, false);
    expected.set(op.sig, idxBytes);
    expected.set(op.hash, idxBytes + sigBytes);
    view.setBigUint64(idxBytes + sigBytes + shaBytes, BigInt(op.len), false);
    expected.set(op.cipherOp, idxBytes + sigBytes + shaBytes + lenBytes);
    assertEquals(result, expected);
  });
});
