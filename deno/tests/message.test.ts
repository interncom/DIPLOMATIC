import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import {
  encodeOp,
  decodeOp,
  IMessage,
  genInsert,
  genDelete,
} from "../../shared/message.ts";
import libsodiumCrypto from "../src/crypto.ts";

// Constants that remain fixed
const keyPathBytes = 8;
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
    const [encoded, header] = await encodeOp(op);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
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
    const [encoded, header] = await encodeOp(op);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
  });

  await t.step("delete operation (len=0, no body)", async () => {
    const op = genDelete(createFilledArray(16, 0x33), new Date(0), 999);
    const [encoded, header] = await encodeOp(op);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, undefined); // No body
  });

  await t.step("genInsert round-trip", async () => {
    const content = createFilledArray(42, 0xcc);
    const op = await genInsert(new Date(555555555000), content, crypto);
    const [encoded, header] = await encodeOp(op);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid.length, eidBytes);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, op.bod);
  });

  await t.step("edge: empty body (upsert)", async () => {
    const op: IMessage = {
      eid: createFilledArray(16, 0x44),
      clk: new Date(1111111110000),
      ctr: 1,
      len: 0,
      bod: undefined,
    };
    const [encoded, header] = await encodeOp(op);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.len, op.len);
    assertEquals(decoded.bod, undefined);
  });
});
