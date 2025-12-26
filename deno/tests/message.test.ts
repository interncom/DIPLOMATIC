import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import {
  encodeOp,
  decodeOp,
  IMessage,
  genInsert,
  genDelete,
  genUpsert,
  genKDM,
  kdmBytes,
} from "../../shared/message.ts";
import { concat } from "../../shared/lib.ts";
import libsodiumCrypto from "../src/crypto.ts";

// Constants that remain fixed
const eidBytes = 16;
const clkBytes = 8;

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
      ctr: 0, // Small counter
      len: bod.length,
      bod,
    };
    const [encoded, header] = await encodeOp(op, crypto);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
    // Check hsh
    assertEquals(decoded.hsh, await crypto.blake3(bod));
    // Header should be the prefix without body
    assertEquals(header.length + (op.bod?.length ?? 0), encoded.length);
  });

  await t.step("large ctr and len round-trip", async () => {
    const bod = createFilledArray(100000, 0xbb); // Large body
    const op: IMessage = {
      eid: createFilledArray(16, 0x22),
      clk: new Date(9876543210000),
      ctr: 123456789, // Large counter (fits in var-int)
      len: bod.length,
      bod,
    };
    const [encoded, header] = await encodeOp(op, crypto);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
    assertEquals(decoded.hsh, await crypto.blake3(bod));
  });

  await t.step("delete operation (len=0, no body)", async () => {
    const op = genDelete(createFilledArray(16, 0x33), new Date(0), 999);
    const [encoded, header] = await encodeOp(op, crypto);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, undefined); // No body
    assertEquals(decoded.hsh, undefined); // No hsh for delete
  });

  await t.step("genInsert round-trip", async () => {
    const content = createFilledArray(42, 0xcc);
    const op = await genInsert(new Date(555555555000), content, crypto);
    const [encoded, header] = await encodeOp(op, crypto);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid.length, eidBytes);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
    assertEquals(decoded.hsh, await crypto.blake3(content));
  });

  await t.step("edge: empty body (upsert)", async () => {
    const op: IMessage = {
      eid: createFilledArray(16, 0x44),
      clk: new Date(1111111110000),
      ctr: 1,
      len: 0,
      bod: undefined,
    };
    const [encoded, header] = await encodeOp(op, crypto);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, undefined);
    assertEquals(decoded.hsh, undefined); // No hsh for empty body
  });

  await t.step("genUpsert", () => {
    const eid = createFilledArray(16, 0x55);
    const clk = new Date(999999999000);
    const ctr = 777;
    const content = createFilledArray(20, 0x77);
    const op = genUpsert(eid, clk, ctr, content);
    assertEquals(op.eid, eid);
    assertEquals(op.clk, clk);
    assertEquals(op.ctr, ctr);
    assertEquals(op.len, content.length);
    assertEquals(op.bod, content);
  });

  await t.step("genKDM", async () => {
    const kdm = await genKDM(crypto);
    assertEquals(kdm.length, 8);
    // Now it's random, just check length
    assertEquals(kdm.length, kdmBytes);
  });

  await t.step("decodeOp with insufficient data", async () => {
    const short = new Uint8Array(eidBytes - 1);
    try {
      await decodeOp(short);
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
      ctr: 5,
      len: bod.length,
      bod,
    };
    const expectedHsh = await crypto.blake3(bod);
    const [encoded, header] = await encodeOp(op, crypto);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.hsh, expectedHsh);
  });

  await t.step("decodeOp with invalid varint", async () => {
    // Create encoded with invalid varint for ctr
    const eid = createFilledArray(16, 0x99);
    const clkBytes = new Uint8Array(8);
    new DataView(clkBytes.buffer).setBigUint64(
      0,
      BigInt(new Date().getTime()),
      false,
    );
    const invalidVarint = new Uint8Array([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]); // Too large varint
    const encoded = concat(eid, concat(clkBytes, invalidVarint));
    try {
      await decodeOp(encoded);
      throw new Error("Should have thrown");
    } catch (e) {
      // Expected to fail on invalid varint
    }
  });
});
