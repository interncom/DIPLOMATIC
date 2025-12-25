import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Decoder } from "../../shared/codec.ts";
import { encode_varint, decode_varint } from "../../shared/codec.ts";
import { concat } from "../../shared/lib.ts";

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

Deno.test("Decoder readBytes negative num", () => {
  const data = new Uint8Array([1, 2, 3]);
  const decoder = new Decoder(data);
  assertThrows(
    () => decoder.readBytes(-1),
    Error,
    "Cannot read negative number of bytes",
  );
});

Deno.test("Decoder readBytes more than available", () => {
  const data = new Uint8Array([1, 2, 3]);
  const decoder = new Decoder(data);
  assertThrows(
    () => decoder.readBytes(5),
    Error,
    "Not enough data to read requested bytes",
  );
});

Deno.test("Decoder readBytes zero", () => {
  const data = new Uint8Array([1, 2, 3]);
  const decoder = new Decoder(data);
  const bytes = decoder.readBytes(0);
  assertEquals(bytes, new Uint8Array(0));
  assertEquals(decoder.consumed(), 0);
});

Deno.test("Decoder readBigInt not enough data", () => {
  const data = new Uint8Array([1, 2, 3]);
  const decoder = new Decoder(data);
  assertThrows(
    () => decoder.readBigInt(),
    Error,
    "Not enough data to read BigInt (needs 8 bytes)",
  );
});

Deno.test("Decoder readVarInt no data", () => {
  const data = new Uint8Array([]);
  const decoder = new Decoder(data);
  assertThrows(
    () => decoder.readVarInt(),
    Error,
    "Not enough data to read VarInt",
  );
});

Deno.test("Decoder readVarInt truncated", () => {
  // Varint for a large number but cut off
  const data = new Uint8Array([0x80, 0x80]); // Incomplete varint
  const decoder = new Decoder(data);
  assertThrows(() => decoder.readVarInt()); // Assuming decode_varint throws
});

Deno.test("Decoder on empty data", () => {
  const data = new Uint8Array([]);
  const decoder = new Decoder(data);
  assertEquals(decoder.done(), true);
  assertEquals(decoder.consumed(), 0);
});

Deno.test("Decoder consumed after partial read", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const decoder = new Decoder(data);
  decoder.readBytes(2);
  assertEquals(decoder.consumed(), 2);
  assertEquals(decoder.done(), false);
});

Deno.test("Decoder done after full read", () => {
  const data = new Uint8Array([1, 2, 3]);
  const decoder = new Decoder(data);
  decoder.readBytes(3);
  assertEquals(decoder.done(), true);
  assertEquals(decoder.consumed(), 3);
});

Deno.test("Encoder writeVarInt negative", () => {
  const encoder = new Encoder();
  assertThrows(
    () => encoder.writeVarInt(-1),
    Error,
    "Cannot write negative VarInt",
  );
});

Deno.test("Encoder writeBytes empty", () => {
  const encoder = new Encoder();
  encoder.writeBytes(new Uint8Array(0));
  const result = encoder.result();
  assertEquals(result.length, 0);
});

Deno.test("Encoder writeBigInt max value", () => {
  const encoder = new Encoder();
  encoder.writeBigInt(2n ** 64n - 1n);
  const result = encoder.result();
  assertEquals(result.length, 8);
});

Deno.test("Encoder multiple result calls", () => {
  const encoder = new Encoder();
  encoder.writeBytes(new Uint8Array([1, 2]));
  const result1 = encoder.result();
  const result2 = encoder.result();
  assertEquals(result1, result2);
  assertEquals(result1, new Uint8Array([1, 2]));
});

Deno.test("Decoder readBytes at exact end", () => {
  const data = new Uint8Array([10, 20]);
  const decoder = new Decoder(data);
  const bytes = decoder.readBytes(2);
  assertEquals(bytes, data);
  assertEquals(decoder.done(), true);
  assertThrows(
    () => decoder.readBytes(1),
    Error,
    "Not enough data to read requested bytes",
  );
});

Deno.test("encode_varint 0", () => {
  const encoded = encode_varint(0);
  assertEquals(encoded, new Uint8Array([0]));
});

Deno.test("decode_varint 0", () => {
  const { value, bytesRead } = decode_varint(new Uint8Array([0]));
  assertEquals(value, 0);
  assertEquals(bytesRead, 1);
});

Deno.test("roundtrip small numbers", () => {
  for (let i = 1; i < 1000; i++) {
    const encoded = encode_varint(i);
    const { value } = decode_varint(encoded);
    assertEquals(value, i);
  }
});

Deno.test("roundtrip large number", () => {
  const n = 123456789;
  const encoded = encode_varint(n);
  const { value } = decode_varint(encoded);
  assertEquals(value, n);
});

Deno.test("encode_varint 32-bit max", () => {
  const n = 2 ** 32 - 1;
  const encoded = encode_varint(n);
  const { value } = decode_varint(encoded);
  assertEquals(value, n);
});

Deno.test("decode_varint with offset", () => {
  const data = new Uint8Array([0x80, 0x01, 0x00]); // varint 128 + data
  const { value, bytesRead } = decode_varint(data, 0);
  assertEquals(value, 128);
  assertEquals(bytesRead, 2);
});

Deno.test("decode_varint incomplete throws error", () => {
  assertThrows(() => {
    decode_varint(new Uint8Array([0x80])); // incomplete
  });
});

Deno.test("decode_varint too long throws error", () => {
  const longVarint = new Uint8Array(10);
  longVarint.fill(0x80);
  assertThrows(
    () => {
      decode_varint(longVarint);
    },
    Error,
    "Varint too long",
  );
});

Deno.test("Encoder writeDate", () => {
  const encoder = new Encoder();
  const date = new Date("2023-10-01T12:00:00Z");
  encoder.writeDate(date);
  const result = encoder.result();
  // Date encodes to 8 bytes BigInt
  assertEquals(result.length, 8);
  // Decode back to verify
  const decoder = new Decoder(result);
  const decodedDate = decoder.readDate();
  assertEquals(decodedDate.getTime(), date.getTime());
});

Deno.test("Decoder readDate", () => {
  const encoder = new Encoder();
  const originalDate = new Date(1696161600000); // 2023-10-01T12:00:00Z in ms
  encoder.writeDate(originalDate);
  const data = encoder.result();
  const decoder = new Decoder(data);
  const decodedDate = decoder.readDate();
  assertEquals(decodedDate, originalDate);
  assertEquals(decoder.done(), true);
});

Deno.test("Date roundtrip sequential", () => {
  const encoder = new Encoder();
  const date1 = new Date("2020-01-01T00:00:00Z");
  const date2 = new Date("2030-12-31T23:59:59.999Z");
  encoder.writeDate(date1);
  encoder.writeDate(date2);
  const encoded = encoder.result();
  const decoder = new Decoder(encoded);
  const decodedDate1 = decoder.readDate();
  const decodedDate2 = decoder.readDate();
  assertEquals(decodedDate1, date1);
  assertEquals(decodedDate2, date2);
  assertEquals(decoder.done(), true);
});

Deno.test("Decoder readDate not enough data", () => {
  const data = new Uint8Array([1, 2, 3]);
  const decoder = new Decoder(data);
  assertThrows(
    () => decoder.readDate(),
    Error,
    "Not enough data to read BigInt (needs 8 bytes)",
  );
});
