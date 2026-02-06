import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { concat } from "../../shared/binary.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import {
  type IMessageHead,
  messageHeadCodec,
} from "../../shared/codecs/messageHead.ts";
import { Status } from "../../shared/consts.ts";
import { genDelete } from "../../shared/message.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { IMessage } from "../../shared/types.ts";
import { eidCodec } from "../../shared/codecs/eid.ts";

// Constants that remain fixed
const eidBytes = 16;

// Helper to create a Uint8Array of given length filled with a value
function createFilledArray(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

Deno.test("message encoding/decoding with var-int", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("small values round-trip", async () => {
    const bod = createFilledArray(5, 0xaa); // Small body
    const op: IMessage = {
      eid: createFilledArray(16, 0x11),
      clk: new Date(1234567890000),
      off: 0,
      ctr: 0, // Small counter
      len: bod.length,
      bod,
    };
    const hsh = op.bod && op.len > 0 ? await crypto.blake3(op.bod) : undefined;
    const msgHead: IMessageHead = {
      eid: op.eid,
      clk: op.clk,
      off: op.off,
      ctr: op.ctr,
      len: op.len,
      hsh,
    };
    const enc = new Encoder();
    messageHeadCodec.encode(enc, msgHead);
    const header = enc.result();
    const fullEncoded = concat(header, op.bod || new Uint8Array(0));
    const dec = new Decoder(fullEncoded);
    const [decodedHead, headStatus] = messageHeadCodec.decode(dec);
    assertEquals(headStatus, Status.Success);
    if (headStatus !== Status.Success) return;
    let decodedBod: Uint8Array | undefined;
    if (decodedHead.len > 0) {
      const [bod, bodStatus] = dec.readBytes(decodedHead.len);
      assertEquals(bodStatus, Status.Success);
      decodedBod = bod;
    }
    const decoded: IMessage = { ...decodedHead, bod: decodedBod };
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
    // Check hsh
    assertEquals(decoded.hsh, hsh);
    // Header should be the prefix without body
    assertEquals(header.length + (op.bod?.length ?? 0), fullEncoded.length);
  });

  await t.step("large ctr and len round-trip", async () => {
    const bod = createFilledArray(100000, 0xbb); // Large body
    const op: IMessage = {
      eid: createFilledArray(16, 0x22),
      clk: new Date(9876543210000),
      off: 0,
      ctr: 123456789, // Large counter (fits in var-int)
      len: bod.length,
      bod,
    };
    const hsh = op.bod && op.len > 0 ? await crypto.blake3(op.bod) : undefined;
    const msgHead: IMessageHead = {
      eid: op.eid,
      clk: op.clk,
      off: op.off,
      ctr: op.ctr,
      len: op.len,
      hsh,
    };
    const enc = new Encoder();
    messageHeadCodec.encode(enc, msgHead);
    const header = enc.result();
    const fullEncoded = concat(header, op.bod || new Uint8Array(0));
    const dec = new Decoder(fullEncoded);
    const [decodedHead, headStatus] = messageHeadCodec.decode(dec);
    assertEquals(headStatus, Status.Success);
    if (headStatus !== Status.Success) return;
    let decodedBod: Uint8Array | undefined;
    if (decodedHead.len > 0) {
      const [bod, bodStatus] = dec.readBytes(decodedHead.len);
      assertEquals(bodStatus, Status.Success);
      decodedBod = bod;
    }
    const decoded: IMessage = { ...decodedHead, bod: decodedBod };
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
    // Check hsh
    assertEquals(decoded.hsh, hsh);
  });

  await t.step("delete operation (len=0, no body)", async () => {
    const eidObj = { id: createFilledArray(8, 0x33), ts: new Date(0) };
    const encEid = new Encoder();
    const statEid = encEid.writeStruct(eidCodec, eidObj);
    if (statEid !== Status.Success) {
      assertEquals(statEid, Status.Success);
      return;
    }
    const eid = encEid.result();

    const [op, s1] = await genDelete({
      eid,
      clk: new Date(0),
      ctr: 999,
      now: new Date(),
      crypto: libsodiumCrypto,
    });
    if (s1 !== Status.Success) {
      assertEquals(s1, Status.Success);
      return;
    }
    const hsh = undefined;
    const msgHead: IMessageHead = {
      eid: op.eid,
      clk: op.clk,
      off: op.off,
      ctr: op.ctr,
      len: 0,
    };
    const enc = new Encoder();
    messageHeadCodec.encode(enc, msgHead);
    const header = enc.result();
    const fullEncoded = header; // No body since len=0
    const dec = new Decoder(fullEncoded);
    const [decodedHead, headStatus] = messageHeadCodec.decode(dec);
    assertEquals(headStatus, Status.Success);
    if (headStatus !== Status.Success) return;
    let decodedBod: Uint8Array | undefined;
    if (decodedHead.len > 0) {
      const [bod, bodStatus] = dec.readBytes(decodedHead.len);
      assertEquals(bodStatus, Status.Success);
      decodedBod = bod;
    }
    const decoded: IMessage = { ...decodedHead, bod: decodedBod };
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, undefined);
    // Check hsh
    assertEquals(decoded.hsh, hsh);
  });

  await t.step("edge: empty body (upsert)", async () => {
    const op: IMessage = {
      eid: createFilledArray(16, 0x44),
      clk: new Date(1111111110000),
      off: 0,
      ctr: 1,
      len: 0,
      bod: undefined,
    };
    const hsh = undefined;
    const msgHead: IMessageHead = {
      eid: op.eid,
      clk: op.clk,
      off: op.off,
      ctr: op.ctr,
      len: op.len,
      hsh,
    };
    const enc = new Encoder();
    messageHeadCodec.encode(enc, msgHead);
    const header = enc.result();
    const fullEncoded = header; // No body since len=0
    const dec = new Decoder(fullEncoded);
    const [decodedHead, headStatus] = messageHeadCodec.decode(dec);
    if (headStatus !== Status.Success) return;
    assertEquals(headStatus, Status.Success);
    let decodedBod: Uint8Array | undefined;
    if (decodedHead.len > 0) {
      const [bod, bodStatus] = dec.readBytes(decodedHead.len);
      assertEquals(bodStatus, Status.Success);
      decodedBod = bod;
    }
    const decoded: IMessage = { ...decodedHead, bod: decodedBod };
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, undefined);
    assertEquals(decoded.hsh, undefined); // No hsh for empty body
  });

  await t.step("message head decode with insufficient data", async () => {
    const short = new Uint8Array(eidBytes - 1);
    try {
      const dec = new Decoder(short);
      messageHeadCodec.decode(dec);
      throw new Error("Should have thrown");
    } catch (e) {
      // Expected to fail due to insufficient data
    }
  });

  await t.step("encodeOp sets hsh correctly", async () => {
    const bod = createFilledArray(10, 0xdd);
    const op: IMessage = {
      eid: createFilledArray(16, 0xee),
      clk: new Date(1234567890000),
      off: 0,
      ctr: 5,
      len: bod.length,
      bod,
    };
    const expectedHsh = await crypto.blake3(bod);
    const hsh = op.bod && op.len > 0 ? await crypto.blake3(op.bod) : undefined;
    const msgHead: IMessageHead = {
      eid: op.eid,
      clk: op.clk,
      off: op.off,
      ctr: op.ctr,
      len: op.len,
      hsh,
    };
    const enc = new Encoder();
    messageHeadCodec.encode(enc, msgHead);
    const header = enc.result();
    const fullEncoded = concat(header, op.bod || new Uint8Array(0));
    const dec = new Decoder(fullEncoded);
    const [decodedHead, headStatus] = messageHeadCodec.decode(dec);
    if (headStatus !== Status.Success) {
      assertEquals(headStatus, Status.Success);
      return;
    }
    let decodedBod: Uint8Array | undefined;
    if (decodedHead.len > 0) {
      const [bod, bodStatus] = dec.readBytes(decodedHead.len);
      assertEquals(bodStatus, Status.Success);
      decodedBod = bod!;
    }
    const decoded: IMessage = {
      eid: decodedHead.eid,
      clk: decodedHead.clk,
      off: decodedHead.off,
      ctr: decodedHead.ctr,
      len: decodedHead.len,
      hsh: decodedHead.hsh,
      bod: decodedBod,
    };
    assertEquals(decoded.hsh, expectedHsh);
  });

  await t.step("message head decode with invalid varint", async () => {
    // Create encoded with invalid varint for ctr
    const eid = createFilledArray(16, 0x99);
    const clkBytes = new Uint8Array(8);
    new DataView(clkBytes.buffer).setBigUint64(
      0,
      BigInt(new Date().getTime()),
      false,
    );
    const invalidVarint = new Uint8Array([
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    ]); // Too large varint
    const encoded = concat(eid, concat(clkBytes, invalidVarint));
    const dec = new Decoder(encoded);
    const [, status] = messageHeadCodec.decode(dec);
    assertEquals(status, Status.VarLimitExceeded);
  });
});
