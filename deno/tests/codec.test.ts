import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Decoder } from "../../shared/codec.ts";
import { encode_varint } from "../../shared/varint.ts";
import { concat } from "../../shared/message.ts";

Deno.test("Decoder readBytes", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const decoder = new Decoder(data);
  const bytes = decoder.readBytes(3);
  assertEquals(bytes, new Uint8Array([1, 2, 3]));
  assertEquals(decoder.done(), false);
});

Deno.test("Decoder readBigInt", () => {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 1234567890123456789n, false);
  const decoder = new Decoder(data);
  const bigint = decoder.readBigInt();
  assertEquals(bigint, 1234567890123456789n);
  assertEquals(decoder.done(), true);
});

Deno.test("Decoder readVarInt", () => {
  const varint = encode_varint(42);
  const decoder = new Decoder(varint);
  const num = decoder.readVarInt();
  assertEquals(num, 42);
  assertEquals(decoder.done(), true);
});

Deno.test("Decoder sequential reads", () => {
  // Create some data: 4 bytes, then 8 bytes bigint, then varint, then 2 bytes
  const bytes4 = new Uint8Array([1, 2, 3, 4]);
  const bigintData = new Uint8Array(8);
  new DataView(bigintData.buffer).setBigUint64(0, 999n, false);
  const varintData = encode_varint(5);
  const bytes2 = new Uint8Array([7, 8]);
  const all = concat(bytes4, bigintData);
  const temp = concat(all, varintData);
  const data = concat(temp, bytes2);
  const decoder = new Decoder(data);
  const b4 = decoder.readBytes(4);
  assertEquals(b4, bytes4);
  const bi = decoder.readBigInt();
  assertEquals(bi, 999n);
  const vi = decoder.readVarInt();
  assertEquals(vi, 5);
  const b2 = decoder.readBytes(2);
  assertEquals(b2, bytes2);
  assertEquals(decoder.done(), true);
});

Deno.test("Decoder readBytes at end", () => {
  const data = new Uint8Array([10, 20]);
  const decoder = new Decoder(data);
  const bytes = decoder.readBytes(2);
  assertEquals(bytes, data);
  assertEquals(decoder.done(), true);
});

Deno.test("Decoder consumed", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const decoder = new Decoder(data);
  decoder.readBytes(2);
  assertEquals(decoder.consumed(), 2);
  decoder.readBytes(2);
  assertEquals(decoder.consumed(), 4);
  assertEquals(decoder.done(), true);
});

import { Encoder } from "../../shared/codec.ts";

Deno.test("Encoder writeBytes", () => {
  const encoder = new Encoder();
  const bytes = new Uint8Array([1, 2, 3]);
  encoder.writeBytes(bytes);
  const result = encoder.result();
  assertEquals(result, bytes);
});

Deno.test("Encoder writeBigInt", () => {
  const encoder = new Encoder();
  encoder.writeBigInt(1234567890123456789n);
  const result = encoder.result();
  const expected = new Uint8Array(8);
  new DataView(expected.buffer).setBigUint64(0, 1234567890123456789n, false);
  assertEquals(result, expected);
});

Deno.test("Encoder writeVarInt", () => {
  const encoder = new Encoder();
  encoder.writeVarInt(42);
  const result = encoder.result();
  assertEquals(result, encode_varint(42));
});

Deno.test("Encoder sequential writes", () => {
  const encoder = new Encoder();
  encoder.writeBytes(new Uint8Array([1, 2]));
  encoder.writeBigInt(999n);
  encoder.writeVarInt(5);
  encoder.writeBytes(new Uint8Array([7, 8]));
  const result = encoder.result();
  // Expected: [1,2] + 8 bytes big endian 999 + varint 5 + [7,8]
  const bytes4 = new Uint8Array([1, 2]);
  const bigintData = new Uint8Array(8);
  new DataView(bigintData.buffer).setBigUint64(0, 999n, false);
  const varintData = encode_varint(5);
  const bytes2 = new Uint8Array([7, 8]);
  const expected = concat(
    bytes4,
    concat(bigintData, concat(varintData, bytes2)),
  );
  assertEquals(result, expected);
});

Deno.test("Encoder empty", () => {
  const encoder = new Encoder();
  const result = encoder.result();
  assertEquals(result.length, 0);
});
