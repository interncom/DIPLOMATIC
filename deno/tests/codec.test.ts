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
