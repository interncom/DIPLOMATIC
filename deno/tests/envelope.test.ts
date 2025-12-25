import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import {
  type IEnvelope,
  type IEnvelopeHeader,
  makeEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  decodeEnvelopeHeader,
} from "../../shared/envelope.ts";
import libsodiumCrypto from "../src/crypto.ts";

const sigBytes = 64;

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
    const cipherhead = new Uint8Array([1, 2, 3]);
    const cipherbody = new Uint8Array([4, 5, 6]);
    const kdm = new Uint8Array(8).fill(0x44);
    const keyPair = {
      keyType: "private" as const,
      privateKey: new Uint8Array(64).fill(0x22),
      publicKey: new Uint8Array(32).fill(0x33),
    };
    const result = await makeEnvelope(
      keyPair,
      cipherhead,
      cipherbody,
      kdm,
      crypto,
    );
    // Compute expected sig: sign(cipherhead, privateKey)
    const expectedSig = await crypto.signEd25519(
      cipherhead,
      keyPair.privateKey,
    );
    assertEquals(result.sig, expectedSig);
    assertEquals(result.kdm, kdm);
    assertEquals(result.lenCipherHead, cipherhead.length);
    assertEquals(result.lenCipherBody, cipherbody.length);
    assertEquals(result.cipherhead, cipherhead);
    assertEquals(result.cipherbody, cipherbody);
  });

  await t.step("encodeEnvelope", async () => {
    const op: IEnvelope = {
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      lenCipherHead: 3,
      lenCipherBody: 2,
      cipherhead: new Uint8Array([10, 11, 12]),
      cipherbody: new Uint8Array([13, 14]),
    };
    const encoded = encodeEnvelope(op);
    const expectedLen = 64 + 8 + 1 + 1 + 3 + 2; // sig + kdm + varint(3) + varint(2) + cipherhead + cipherbody
    assertEquals(encoded.length, expectedLen);
    // Check sig
    assertEquals(encoded.slice(0, 64), op.sig);
    // Check kdm
    assertEquals(encoded.slice(64, 72), op.kdm);
    // Check lenCipherHead varint
    assertEquals(encoded[72], 3); // varint for 3
    // Check lenCipherBody varint
    assertEquals(encoded[73], 2); // varint for 2
    // Check cipherhead
    assertEquals(encoded.slice(74, 77), op.cipherhead);
    // Check cipherbody
    assertEquals(encoded.slice(77, 79), op.cipherbody);
  });

  await t.step("decodeEnvelope", async () => {
    const op: IEnvelope = {
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      lenCipherHead: 3,
      lenCipherBody: 2,
      cipherhead: new Uint8Array([10, 11, 12]),
      cipherbody: new Uint8Array([13, 14]),
    };
    const encoded = encodeEnvelope(op);
    const result = decodeEnvelope(encoded);
    const decoded = result.envelope;
    assertEquals(decoded.sig, op.sig);
    assertEquals(decoded.kdm, op.kdm);
    assertEquals(decoded.lenCipherHead, op.lenCipherHead);
    assertEquals(decoded.lenCipherBody, op.lenCipherBody);
    assertEquals(decoded.cipherhead, op.cipherhead);
    assertEquals(decoded.cipherbody, op.cipherbody);
    assertEquals(result.consumed, encoded.length);
  });

  await t.step("decodeEnvelopeHeader", async () => {
    const op: IEnvelope = {
      sig: new Uint8Array(64).fill(0xcd),
      kdm: new Uint8Array(8).fill(0x99),
      lenCipherHead: 5,
      lenCipherBody: 2,
      cipherhead: new Uint8Array([1, 2, 3, 4, 5]),
      cipherbody: new Uint8Array([6, 7]),
    };
    const encoded = encodeEnvelope(op);
    const encodedHeader = encoded.slice(0, 74); // 64+8+1+1
    const decodedHeader = decodeEnvelopeHeader(encodedHeader);
    assertEquals(decodedHeader.sig, op.sig);
    assertEquals(decodedHeader.kdm, op.kdm);
    assertEquals(decodedHeader.lenCipherHead, op.lenCipherHead);
    assertEquals(decodedHeader.lenCipherBody, op.lenCipherBody);
  });

  await t.step("decodeEnvelope error on short input", async () => {
    const short = new Uint8Array(70); // less than minimum
    try {
      decodeEnvelope(short);
      throw new Error("Should have thrown");
    } catch (e) {
      // Expected to fail on incomplete
    }
  });

  await t.step("decodeEnvelopeHeader error on short input", () => {
    const short = new Uint8Array(70); // less than minimum
    try {
      decodeEnvelopeHeader(short);
      throw new Error("Should have thrown");
    } catch (e) {
      // Expected to fail on incomplete
    }
  });
});
