import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { encodeOp, decodeOp, IMessage } from "../../web/src/shared/message.ts";
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

Deno.test("message", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("encodeOp", async () => {
    const bod = new Uint8Array([1, 2, 3]);
    const op = {
      eid: new Uint8Array(16).fill(0x11),
      clk: new Date(1234567890000),
      ctr: 42,
      len: bod.length,
      bod,
    };
    const [result] = await encodeOp(op);
    // Build expected manually (assuming SHA is fixed for test)
    const expectedLen = op.bod.length;
    const expectedMessage = new Uint8Array(
      eidBytes + clkBytes + ctrBytes + lenBytes + expectedLen,
    );
    const view = new DataView(
      expectedMessage.buffer,
      expectedMessage.byteOffset,
    );
    expectedMessage.set(op.eid, 0);
    view.setBigUint64(eidBytes, BigInt(op.clk.getTime()), false);
    view.setUint32(eidBytes + clkBytes, op.ctr, false);
    view.setBigUint64(
      eidBytes + clkBytes + ctrBytes,
      BigInt(expectedLen),
      false,
    );
    expectedMessage.set(op.bod, eidBytes + clkBytes + ctrBytes + lenBytes);
    assertEquals(result, expectedMessage);
  });

  await t.step("decodeOp", async () => {
    const bod = new Uint8Array([1, 2, 3]);
    const op: IMessage = {
      eid: new Uint8Array(16).fill(0x11),
      clk: new Date(1234567890000),
      ctr: 42,
      len: bod.length,
      bod,
    };
    const [encoded] = await encodeOp(op);
    const decoded = await decodeOp(encoded);
    assertEquals(decoded.eid, op.eid);
    assertEquals(decoded.clk.getTime(), op.clk.getTime());
    assertEquals(decoded.ctr, op.ctr);
    assertEquals(decoded.bod, op.bod);
  });
});
