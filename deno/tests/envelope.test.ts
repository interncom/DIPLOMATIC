import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import {
  encodeEnvelope,
  makeEnvelope,
  decodeEnvelope,
} from "../../web/src/shared/envelope.ts";
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

Deno.test("envelope", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("makeEnvelope", async () => {
    const cipherOp = new Uint8Array([4, 5, 6]);
    const keyPair = {
      keyType: "private" as const,
      privateKey: new Uint8Array(64).fill(0x22),
      publicKey: new Uint8Array(32).fill(0x33),
    };
    const result = await makeEnvelope(keyPair, cipherOp, crypto);
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
    assertEquals(result.hsh, expectedHash);
    assertEquals(result.len, len);
    assertEquals(result.msg, cipherOp);
  });

  await t.step("encodeEnvelope", async () => {
    const idx = 5;
    const op = {
      sig: new Uint8Array(64).fill(0x77),
      hsh: new Uint8Array(32).fill(0x88),
      len: 99,
      msg: new Uint8Array([10, 11, 12]),
    };
    const result = await encodeEnvelope(idx, op);
    // Expected
    const expected = new Uint8Array(
      idxBytes + sigBytes + shaBytes + lenBytes + op.msg.length,
    );
    const view = new DataView(expected.buffer, expected.byteOffset);
    view.setUint32(0, idx, false);
    expected.set(op.sig, idxBytes);
    expected.set(op.hsh, idxBytes + sigBytes);
    view.setBigUint64(idxBytes + sigBytes + shaBytes, BigInt(op.len), false);
    expected.set(op.msg, idxBytes + sigBytes + shaBytes + lenBytes);
    assertEquals(result, expected);
  });

  await t.step("decodeEnvelope", async () => {
    const idx = 5;
    const op = {
      sig: new Uint8Array(64).fill(0x77),
      hsh: new Uint8Array(32).fill(0x88),
      len: 99,
      msg: new Uint8Array([10, 11, 12]),
    };
    const encoded = await encodeEnvelope(idx, op);
    const decoded = await decodeEnvelope(encoded);
    assertEquals(decoded.sig, op.sig);
    assertEquals(decoded.hsh, op.hsh);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.msg, op.msg);
  });
});
