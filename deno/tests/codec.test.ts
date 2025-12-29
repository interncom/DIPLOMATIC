import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Decoder } from "../../shared/codec.ts";
import { decodeVarInt, encodeVarInt } from "../../shared/codec.ts";
import { concat } from "../../shared/lib.ts";

Deno.test("Decoder readBytes", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const dec = new Decoder(data);
  const bytes = dec.readBytes(3);
  assertEquals(bytes, new Uint8Array([1, 2, 3]));
  assertEquals(dec.done(), false);
});

Deno.test("Decoder readBigInt", () => {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 1234567890123456789n, false);
  const dec = new Decoder(data);
  const bigint = dec.readBigInt();
  assertEquals(bigint, 1234567890123456789n);
  assertEquals(dec.done(), true);
});

Deno.test("Decoder readVarInt", () => {
  const varint = encodeVarInt(42);
  const dec = new Decoder(varint);
  const num = dec.readVarInt();
  assertEquals(num, 42);
  assertEquals(dec.done(), true);
});

Deno.test("Decoder sequential reads", () => {
  // Create some data: 4 bytes, then 8 bytes bigint, then varint, then 2 bytes
  const bytes4 = new Uint8Array([1, 2, 3, 4]);
  const bigintData = new Uint8Array(8);
  new DataView(bigintData.buffer).setBigUint64(0, 999n, false);
  const varintData = encodeVarInt(5);
  const bytes2 = new Uint8Array([7, 8]);
  const all = concat(bytes4, bigintData);
  const temp = concat(all, varintData);
  const data = concat(temp, bytes2);
  const dec = new Decoder(data);
  const b4 = dec.readBytes(4);
  assertEquals(b4, bytes4);
  const bi = dec.readBigInt();
  assertEquals(bi, 999n);
  const vi = dec.readVarInt();
  assertEquals(vi, 5);
  const b2 = dec.readBytes(2);
  assertEquals(b2, bytes2);
  assertEquals(dec.done(), true);
});

Deno.test("Decoder readBytes at end", () => {
  const data = new Uint8Array([10, 20]);
  const dec = new Decoder(data);
  const bytes = dec.readBytes(2);
  assertEquals(bytes, data);
  assertEquals(dec.done(), true);
});

Deno.test("Decoder consumed", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const dec = new Decoder(data);
  dec.readBytes(2);
  assertEquals(dec.consumed(), 2);
  dec.readBytes(2);
  assertEquals(dec.consumed(), 4);
  assertEquals(dec.done(), true);
});

import { Encoder } from "../../shared/codec.ts";

Deno.test("Encoder writeBytes", () => {
  const enc = new Encoder();
  const bytes = new Uint8Array([1, 2, 3]);
  enc.writeBytes(bytes);
  const result = enc.result();
  assertEquals(result, bytes);
});

Deno.test("Encoder writeBigInt", () => {
  const enc = new Encoder();
  enc.writeBigInt(1234567890123456789n);
  const result = enc.result();
  const expected = new Uint8Array(8);
  new DataView(expected.buffer).setBigUint64(0, 1234567890123456789n, false);
  assertEquals(result, expected);
});

Deno.test("Encoder writeVarInt", () => {
  const enc = new Encoder();
  enc.writeVarInt(42);
  const result = enc.result();
  assertEquals(result, encodeVarInt(42));
});

Deno.test("Encoder sequential writes", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array([1, 2]));
  enc.writeBigInt(999n);
  enc.writeVarInt(5);
  enc.writeBytes(new Uint8Array([7, 8]));
  const result = enc.result();
  // Expected: [1,2] + 8 bytes big endian 999 + varint 5 + [7,8]
  const bytes4 = new Uint8Array([1, 2]);
  const bigintData = new Uint8Array(8);
  new DataView(bigintData.buffer).setBigUint64(0, 999n, false);
  const varintData = encodeVarInt(5);
  const bytes2 = new Uint8Array([7, 8]);
  const expected = concat(
    bytes4,
    concat(bigintData, concat(varintData, bytes2)),
  );
  assertEquals(result, expected);
});

Deno.test("Encoder empty", () => {
  const enc = new Encoder();
  const result = enc.result();
  assertEquals(result.length, 0);
});

Deno.test("Decoder readBytes negative num", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  assertThrows(
    () => dec.readBytes(-1),
    Error,
    "Cannot read negative number of bytes",
  );
});

Deno.test("Decoder readBytes more than available", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  assertThrows(
    () => dec.readBytes(5),
    Error,
    "Not enough data to read requested bytes",
  );
});

Deno.test("Decoder readBytes zero", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  const bytes = dec.readBytes(0);
  assertEquals(bytes, new Uint8Array(0));
  assertEquals(dec.consumed(), 0);
});

Deno.test("Decoder readBigInt not enough data", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  assertThrows(
    () => dec.readBigInt(),
    Error,
    "Not enough data to read BigInt (needs 8 bytes)",
  );
});

Deno.test("Decoder readVarInt no data", () => {
  const data = new Uint8Array([]);
  const dec = new Decoder(data);
  assertThrows(() => dec.readVarInt(), Error, "Not enough data to read VarInt");
});

Deno.test("Decoder readVarInt truncated", () => {
  // Varint for a large number but cut off
  const data = new Uint8Array([0x80, 0x80]); // Incomplete varint
  const dec = new Decoder(data);
  assertThrows(() => dec.readVarInt()); // Assuming decode_varint throws
});

Deno.test("Decoder on empty data", () => {
  const data = new Uint8Array([]);
  const dec = new Decoder(data);
  assertEquals(dec.done(), true);
  assertEquals(dec.consumed(), 0);
});

Deno.test("Decoder consumed after partial read", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const dec = new Decoder(data);
  dec.readBytes(2);
  assertEquals(dec.consumed(), 2);
  assertEquals(dec.done(), false);
});

Deno.test("Decoder done after full read", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  dec.readBytes(3);
  assertEquals(dec.done(), true);
  assertEquals(dec.consumed(), 3);
});

Deno.test("Encoder writeVarInt negative", () => {
  const enc = new Encoder();
  assertThrows(
    () => enc.writeVarInt(-1),
    Error,
    "Cannot write negative VarInt",
  );
});

Deno.test("Encoder writeBytes empty", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(0));
  const result = enc.result();
  assertEquals(result.length, 0);
});

Deno.test("Encoder writeBigInt max value", () => {
  const enc = new Encoder();
  enc.writeBigInt(2n ** 64n - 1n);
  const result = enc.result();
  assertEquals(result.length, 8);
});

Deno.test("Encoder multiple result calls", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array([1, 2]));
  const result1 = enc.result();
  const result2 = enc.result();
  assertEquals(result1, result2);
  assertEquals(result1, new Uint8Array([1, 2]));
});

Deno.test("Decoder readBytes at exact end", () => {
  const data = new Uint8Array([10, 20]);
  const dec = new Decoder(data);
  const bytes = dec.readBytes(2);
  assertEquals(bytes, data);
  assertEquals(dec.done(), true);
  assertThrows(
    () => dec.readBytes(1),
    Error,
    "Not enough data to read requested bytes",
  );
});

Deno.test("encode_varint 0", () => {
  const encoded = encodeVarInt(0);
  assertEquals(encoded, new Uint8Array([0]));
});

Deno.test("decode_varint 0", () => {
  const { value, bytesRead } = decodeVarInt(new Uint8Array([0]));
  assertEquals(value, 0);
  assertEquals(bytesRead, 1);
});

Deno.test("roundtrip small numbers", () => {
  for (let i = 1; i < 1000; i++) {
    const encoded = encodeVarInt(i);
    const { value } = decodeVarInt(encoded);
    assertEquals(value, i);
  }
});

Deno.test("roundtrip large number", () => {
  const n = 123456789;
  const encoded = encodeVarInt(n);
  const { value } = decodeVarInt(encoded);
  assertEquals(value, n);
});

Deno.test("encode_varint 32-bit max", () => {
  const n = 2 ** 32 - 1;
  const encoded = encodeVarInt(n);
  const { value } = decodeVarInt(encoded);
  assertEquals(value, n);
});

Deno.test("decode_varint with offset", () => {
  const data = new Uint8Array([0x80, 0x01, 0x00]); // varint 128 + data
  const { value, bytesRead } = decodeVarInt(data, 0);
  assertEquals(value, 128);
  assertEquals(bytesRead, 2);
});

Deno.test("decode_varint incomplete throws error", () => {
  assertThrows(() => {
    decodeVarInt(new Uint8Array([0x80])); // incomplete
  });
});

Deno.test("decode_varint too long throws error", () => {
  const longVarint = new Uint8Array(10);
  longVarint.fill(0x80);
  assertThrows(
    () => {
      decodeVarInt(longVarint);
    },
    Error,
    "Varint too long",
  );
});

Deno.test("Encoder writeDate", () => {
  const enc = new Encoder();
  const date = new Date("2023-10-01T12:00:00Z");
  enc.writeDate(date);
  const result = enc.result();
  // Date encodes to 8 bytes BigInt
  assertEquals(result.length, 8);
  // Decode back to verify
  const dec = new Decoder(result);
  const decodedDate = dec.readDate();
  assertEquals(decodedDate.getTime(), date.getTime());
});

Deno.test("Decoder readDate", () => {
  const enc = new Encoder();
  const originalDate = new Date(1696161600000); // 2023-10-01T12:00:00Z in ms
  enc.writeDate(originalDate);
  const data = enc.result();
  const dec = new Decoder(data);
  const decodedDate = dec.readDate();
  assertEquals(decodedDate, originalDate);
  assertEquals(dec.done(), true);
});

Deno.test("Date roundtrip sequential", () => {
  const enc = new Encoder();
  const date1 = new Date("2020-01-01T00:00:00Z");
  const date2 = new Date("2030-12-31T23:59:59.999Z");
  enc.writeDate(date1);
  enc.writeDate(date2);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const decodedDate1 = dec.readDate();
  const decodedDate2 = dec.readDate();
  assertEquals(decodedDate1, date1);
  assertEquals(decodedDate2, date2);
  assertEquals(dec.done(), true);
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

Deno.test("Decoder fromResponse", async () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const response = new Response(data.slice());
  const decoder = await Decoder.fromResponse(response);
  const bytes = decoder.readBytes(3);
  assertEquals(bytes, new Uint8Array([1, 2, 3]));
  assertEquals(decoder.done(), false);
});
