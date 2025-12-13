import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import {
  type IEnvelope,
  encodeEnvelope,
  makeEnvelope,
  decodeEnvelope,
  decodeEnvelopeHeader,
} from "../../shared/envelope.ts";
import libsodiumCrypto from "../src/crypto.ts";

const idxBytes = 8; // Updated to 8 for new layout
const sigBytes = 64;
const shaBytes = 32;
const lenBytes = 8;
const keyPathBytes = 8;
const pubKeyBytes = 32;
const eidBytes = 16;
const clkBytes = 8;
const ctrBytes = 4;
const fixedBytes =
  keyPathBytes + idxBytes + pubKeyBytes + sigBytes + shaBytes + lenBytes; // 152

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
    const idx = 0;
    const cipherOp = new Uint8Array([4, 5, 6]);
    const keyPair = {
      keyType: "private" as const,
      privateKey: new Uint8Array(64).fill(0x22),
      publicKey: new Uint8Array(32).fill(0x33),
    };
    const dkm = new Uint8Array(8).fill(0x44);
    const result = await makeEnvelope(idx, keyPair, cipherOp, dkm, crypto);
    // Expected msg is dkm prepended to cipherOp
    const expectedMsg = new Uint8Array([...dkm, ...cipherOp]);
    // Compute expected values
    const len = keyPathBytes + dkm.length + cipherOp.length;
    const hashSrc = new Uint8Array(len);
    hashSrc.set(new Uint8Array(8).fill(0), 0); // keyPath
    hashSrc.set(dkm, 8);
    hashSrc.set(cipherOp, 16);
    const expectedHash = await crypto.blake3(hashSrc);
    const expectedSig = await crypto.signEd25519(
      expectedHash,
      keyPair.privateKey,
    );
    assertEquals(result.keyPath, "");
    assertEquals(result.idx, idx);
    assertEquals(result.pubKey, keyPair.publicKey);
    assertEquals(result.sig, expectedSig);
    assertEquals(result.hsh, expectedHash);
    assertEquals(result.len, len);
    assertEquals(result.msg, expectedMsg);
  });

  await t.step("encodeEnvelope", async () => {
    const op = {
      keyPath: "",
      idx: 5,
      pubKey: new Uint8Array(32).fill(1),
      sig: new Uint8Array(64).fill(0x77),
      hsh: new Uint8Array(32).fill(0x88),
      len: 99,
      msg: new Uint8Array([10, 11, 12]),
    };
    const result = await encodeEnvelope(op);
    // Expected
    const expected = new Uint8Array(fixedBytes + op.msg.length);
    const view = new DataView(expected.buffer, expected.byteOffset);
    // keyPath: already 0
    view.setBigUint64(8, BigInt(op.idx), false);
    expected.set(op.pubKey, 16);
    expected.set(op.sig, 48);
    expected.set(op.hsh, 112);
    view.setBigUint64(144, BigInt(op.len), false);
    expected.set(op.msg, 152);
    assertEquals(result, expected);
  });

  await t.step("decodeEnvelope", async () => {
    const op = {
      keyPath: "",
      idx: 5,
      pubKey: new Uint8Array(32).fill(1),
      sig: new Uint8Array(64).fill(0x77),
      hsh: new Uint8Array(32).fill(0x88),
      len: 99,
      msg: new Uint8Array([10, 11, 12]),
    };
    const encoded = await encodeEnvelope(op);
    const decoded = decodeEnvelope(encoded);
    assertEquals(decoded.keyPath, op.keyPath);
    assertEquals(decoded.idx, op.idx);
    assertEquals(decoded.pubKey, op.pubKey);
    assertEquals(decoded.sig, op.sig);
    assertEquals(decoded.hsh, op.hsh);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.msg, op.msg);
  });

  await t.step("decodeEnvelopeHeader", async () => {
    const op: IEnvelope = {
      keyPath: "test",
      idx: 123456789,
      pubKey: new Uint8Array(32).fill(0xab),
      sig: new Uint8Array(64).fill(0xcd),
      hsh: new Uint8Array(32).fill(0xef),
      len: 1000,
    };
    const encoded = await encodeEnvelope({
      ...op,
      msg: new Uint8Array(op.len - keyPathBytes),
    });
    const header = encoded.slice(0, fixedBytes);
    const decodedHeader = decodeEnvelopeHeader(header);
    assertEquals(decodedHeader.keyPath, op.keyPath.slice(0, 8));
    assertEquals(decodedHeader.idx, op.idx);
    assertEquals(decodedHeader.pubKey, op.pubKey);
    assertEquals(decodedHeader.sig, op.sig);
    assertEquals(decodedHeader.hsh, op.hsh);
    assertEquals(decodedHeader.len, op.len);
  });

  await t.step("decodeEnvelopeHeader error on short input", () => {
    const short = new Uint8Array(fixedBytes - 1);
    try {
      decodeEnvelopeHeader(short);
      throw new Error("Should have thrown");
    } catch (e) {
      assertEquals((e as Error).message, "Envelope header too short");
    }
  });

  await t.step("decodeEnvelope error on short input", () => {
    const short = new Uint8Array(fixedBytes - 1);
    try {
      decodeEnvelope(short);
      throw new Error("Should have thrown");
    } catch (e) {
      assertEquals((e as Error).message, "Envelope too short");
    }
  });

  await t.step("encodeEnvelope with non-empty keyPath", async () => {
    const op: IEnvelope = {
      keyPath: "abcdefg",
      idx: 42,
      pubKey: new Uint8Array(32).fill(2),
      sig: new Uint8Array(64).fill(0x55),
      hsh: new Uint8Array(32).fill(0x66),
      len: 50,
      msg: new Uint8Array([1, 2, 3]),
    };
    const encoded = await encodeEnvelope(op);
    const decoded = decodeEnvelope(encoded);
    assertEquals(decoded.keyPath, op.keyPath.slice(0, 8));
    assertEquals(decoded.idx, op.idx);
    // Test truncation
  });
});
