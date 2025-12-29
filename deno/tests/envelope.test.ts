import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { decodeEnvelopeHeader, makeEnvelope } from "../../shared/envelope.ts";
import { envelopeCodec } from "../../shared/protocol.ts";
import type { IEnvelope, PrivateKey, PublicKey } from "../../shared/types.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";

Deno.test("envelope", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("makeEnvelope", async () => {
    const headCph = new Uint8Array([1, 2, 3]);
    const bodyCph = new Uint8Array([4, 5, 6]);
    const kdm = new Uint8Array(8).fill(0x44);
    const keyPair = {
      keyType: "private" as const,
      privateKey: new Uint8Array(64).fill(0x22) as PrivateKey,
      publicKey: new Uint8Array(32).fill(0x33) as PublicKey,
    };
    const result = await makeEnvelope(keyPair, headCph, bodyCph, kdm, crypto);
    // Compute expected sig: sign(headCph, privateKey)
    const expectedSig = await crypto.signEd25519(headCph, keyPair.privateKey);
    assertEquals(result.sig, expectedSig);
    assertEquals(result.kdm, kdm);
    assertEquals(result.lenHeadCph, headCph.length);
    assertEquals(result.lenBodyCph, bodyCph.length);
    assertEquals(result.headCph, headCph);
    assertEquals(result.bodyCph, bodyCph);
  });

  await t.step("encodeEnvelope", async () => {
    const op: IEnvelope = {
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      lenHeadCph: 3,
      lenBodyCph: 2,
      headCph: new Uint8Array([10, 11, 12]),
      bodyCph: new Uint8Array([13, 14]),
    };
    const enc = new Encoder();
    enc.writeStruct(envelopeCodec, op);
    const encoded = enc.result();
    const expectedLen = 64 + 8 + 1 + 1 + 3 + 2; // sig + kdm + varint(3) + varint(2) + headCph + bodyCph
    assertEquals(encoded.length, expectedLen);
    // Check sig
    assertEquals(encoded.slice(0, 64), op.sig);
    // Check kdm
    assertEquals(encoded.slice(64, 72), op.kdm);
    // Check lenHeadCph varint
    assertEquals(encoded[72], 3); // varint for 3
    // Check lenBodyCph varint
    assertEquals(encoded[73], 2); // varint for 2
    // Check headCph
    assertEquals(encoded.slice(74, 77), op.headCph);
    // Check bodyCph
    assertEquals(encoded.slice(77, 79), op.bodyCph);
  });

  await t.step("decodeEnvelope", async () => {
    const op: IEnvelope = {
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      lenHeadCph: 3,
      lenBodyCph: 2,
      headCph: new Uint8Array([10, 11, 12]),
      bodyCph: new Uint8Array([13, 14]),
    };
    const enc = new Encoder();
    enc.writeStruct(envelopeCodec, op);
    const encoded = enc.result();
    const decoder = new Decoder(encoded);
    const decoded = decoder.readStruct(envelopeCodec);
    assertEquals(decoded.sig, op.sig);
    assertEquals(decoded.kdm, op.kdm);
    assertEquals(decoded.lenHeadCph, op.lenHeadCph);
    assertEquals(decoded.lenBodyCph, op.lenBodyCph);
    assertEquals(decoded.headCph, op.headCph);
    assertEquals(decoded.bodyCph, op.bodyCph);
    assertEquals(decoder.done(), true);
  });

  await t.step("decodeEnvelopeHeader", async () => {
    const op: IEnvelope = {
      sig: new Uint8Array(64).fill(0xcd),
      kdm: new Uint8Array(8).fill(0x99),
      lenHeadCph: 5,
      lenBodyCph: 2,
      headCph: new Uint8Array([1, 2, 3, 4, 5]),
      bodyCph: new Uint8Array([6, 7]),
    };
    const enc = new Encoder();
    enc.writeStruct(envelopeCodec, op);
    const encoded = enc.result();
    const encodedHeader = encoded.slice(0, 74); // 64+8+1+1
    const decodedHeader = decodeEnvelopeHeader(encodedHeader);
    assertEquals(decodedHeader.sig, op.sig);
    assertEquals(decodedHeader.kdm, op.kdm);
    assertEquals(decodedHeader.lenHeadCph, op.lenHeadCph);
    assertEquals(decodedHeader.lenBodyCph, op.lenBodyCph);
  });

  await t.step("decodeEnvelope error on short input", async () => {
    const short = new Uint8Array(70); // less than minimum
    try {
      const decoder = new Decoder(short);
      decoder.readStruct(envelopeCodec);
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
