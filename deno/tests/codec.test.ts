import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Decoder } from "../../shared/codec.ts";
import { decodeVarInt, encodeVarInt } from "../../shared/codec.ts";
import { concat } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("Decoder readBytes", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const dec = new Decoder(data);
  const [bytes, status] = dec.readBytes(3);
  assertEquals(status, Status.Success);
  assertEquals(bytes, new Uint8Array([1, 2, 3]));
  assertEquals(dec.done(), false);
});

Deno.test("Decoder readBigInt", () => {
  const data = new Uint8Array(8);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, 1234567890123456789n, false);
  const dec = new Decoder(data);
  const [bigint, status] = dec.readBigInt();
  assertEquals(status, Status.Success);
  assertEquals(bigint, 1234567890123456789n);
  assertEquals(dec.done(), true);
});

Deno.test("Decoder readVarInt", () => {
  const [varint, encStatus] = encodeVarInt(42);
  assertEquals(encStatus, Status.Success);
  if (encStatus !== Status.Success) return;
  const dec = new Decoder(varint);
  const [num, decStatus] = dec.readVarInt();
  assertEquals(decStatus, Status.Success);
  assertEquals(num, 42);
  assertEquals(dec.done(), true);
});

Deno.test("Decoder sequential reads", () => {
  // Create some data: 4 bytes, then 8 bytes bigint, then varint, then 2 bytes
  const bytes4 = new Uint8Array([1, 2, 3, 4]);
  const bigintData = new Uint8Array(8);
  new DataView(bigintData.buffer).setBigUint64(0, 999n, false);
  const [varintData, vs] = encodeVarInt(5);
  assertEquals(vs, Status.Success);
  if (vs !== Status.Success) return;
  const bytes2 = new Uint8Array([7, 8]);
  const all = concat(bytes4, bigintData);
  const temp = concat(all, varintData);
  const data = concat(temp, bytes2);
  const dec = new Decoder(data);
  const [b4, s1] = dec.readBytes(4);
  assertEquals(s1, Status.Success);
  assertEquals(b4, bytes4);
  const [bi, s2] = dec.readBigInt();
  assertEquals(s2, Status.Success);
  assertEquals(bi, 999n);
  const [vi, s3] = dec.readVarInt();
  assertEquals(s3, Status.Success);
  assertEquals(vi, 5);
  const [b2, s4] = dec.readBytes(2);
  assertEquals(s4, Status.Success);
  assertEquals(b2, bytes2);
  assertEquals(dec.done(), true);
});

Deno.test("Decoder readBytes at end", () => {
  const data = new Uint8Array([10, 20]);
  const dec = new Decoder(data);
  const [bytes, status] = dec.readBytes(2);
  assertEquals(status, Status.Success);
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
  const status = enc.writeVarInt(42);
  assertEquals(status, Status.Success);
  const result = enc.result();
  const [expected, expStatus] = encodeVarInt(42);
  assertEquals(expStatus, Status.Success);
  assertEquals(result, expected);
});

Deno.test("Encoder sequential writes", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array([1, 2]));
  enc.writeBigInt(999n);
  const vs2 = enc.writeVarInt(5);
  assertEquals(vs2, Status.Success);
  enc.writeBytes(new Uint8Array([7, 8]));
  const result = enc.result();
  // Expected: [1,2] + 8 bytes big endian 999 + varint 5 + [7,8]
  const bytes4 = new Uint8Array([1, 2]);
  const bigintData = new Uint8Array(8);
  new DataView(bigintData.buffer).setBigUint64(0, 999n, false);
  const [varintData, vs] = encodeVarInt(5);
  assertEquals(vs, Status.Success);
  if (vs !== Status.Success) return;
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
  const [bytes, status] = dec.readBytes(-1);
  assertEquals(status, Status.InvalidParam);
  assertEquals(bytes, undefined);
});

Deno.test("Decoder readBytes more than available", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  const [bytes, status] = dec.readBytes(5);
  assertEquals(status, Status.MissingBody);
  assertEquals(bytes, undefined);
});

Deno.test("Decoder readBytes zero", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  const [bytes, status] = dec.readBytes(0);
  assertEquals(status, Status.Success);
  assertEquals(bytes, new Uint8Array(0));
});

Deno.test("Decoder readBigInt not enough data", () => {
  const data = new Uint8Array([1, 2, 3]);
  const dec = new Decoder(data);
  const [result, status] = dec.readBigInt();
  assertEquals(status, Status.MissingBody);
  assertEquals(result, undefined);
});

Deno.test("Decoder readVarInt no data", () => {
  const data = new Uint8Array([]);
  const dec = new Decoder(data);
  const [result, status] = dec.readVarInt();
  assertEquals(status, Status.InvalidMessage);
  assertEquals(result, undefined);
});

Deno.test("Decoder readVarInt truncated", () => {
  // Varint for a large number but cut off
  const data = new Uint8Array([0x80, 0x80]); // Incomplete varint
  const dec = new Decoder(data);
  const [result, status] = dec.readVarInt();
  assertEquals(status, Status.InvalidMessage);
  assertEquals(result, undefined);
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
  const status = enc.writeVarInt(-1);
  assertEquals(status, Status.InvalidParam);
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
  const [bytes, status] = dec.readBytes(2);
  assertEquals(status, Status.Success);
  assertEquals(bytes, data);
  const [bytes2, status2] = dec.readBytes(1);
  assertEquals(status2, Status.MissingBody);
  assertEquals(bytes2, undefined);
});

Deno.test("encode_varint 0", () => {
  const [encoded, encStatus] = encodeVarInt(0);
  assertEquals(encStatus, Status.Success);
  if (encStatus !== Status.Success) return;
  assertEquals(encoded, new Uint8Array([0]));
  const [res, decStatus] = decodeVarInt(new Uint8Array([0]));
  assertEquals(decStatus, Status.Success);
  if (decStatus !== Status.Success) return;
  const { value, bytesRead } = res;
  assertEquals(value, 0);
  assertEquals(bytesRead, 1);
});

Deno.test("decode_varint 0", () => {
  const [res, status] = decodeVarInt(new Uint8Array([0]));
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  const { value, bytesRead } = res;
  assertEquals(value, 0);
  assertEquals(bytesRead, 1);
});

Deno.test("roundtrip small numbers", () => {
  for (const i of [0, 1, 42, 127, 128, 16383, 16384, 0x7fffffff]) {
    const [encoded, encStatus] = encodeVarInt(i);
    assertEquals(encStatus, Status.Success);
    if (encStatus !== Status.Success) return;
    const [res, decStatus] = decodeVarInt(encoded);
    assertEquals(decStatus, Status.Success);
    if (decStatus !== Status.Success) return;
    const { value } = res;
    assertEquals(value, i);
  }
});

Deno.test("roundtrip large number", () => {
  const n = 0x7fffffffffffffffn;
  const [encoded, encStatus] = encodeVarInt(n);
  assertEquals(encStatus, Status.Success);
  if (encStatus !== Status.Success) return;
  const [res, decStatus] = decodeVarInt(encoded);
  assertEquals(decStatus, Status.Success);
  if (decStatus !== Status.Success) return;
  const { value } = res;
  assertEquals(value, n);
});

Deno.test("encode_varint 32-bit max", () => {
  const [encoded, encStatus] = encodeVarInt(0x7fffffff);
  assertEquals(encStatus, Status.Success);
  if (encStatus !== Status.Success) return;
  const [res, decStatus] = decodeVarInt(encoded);
  assertEquals(decStatus, Status.Success);
  if (decStatus !== Status.Success) return;
  const { value } = res;
  assertEquals(value, 0x7fffffff);
});

Deno.test("decode_varint with offset", () => {
  const data = new Uint8Array([0x00, 0x00, 0x05]);
  const [res, status] = decodeVarInt(data, 2);
  assertEquals(status, Status.Success);
  const { value, bytesRead } = res!;
  assertEquals(value, 5);
  assertEquals(bytesRead, 1);
});

Deno.test("decode_varint incomplete throws error", () => {
  const [res, status] = decodeVarInt(new Uint8Array([0x80]));
  assertEquals(status, Status.InvalidMessage);
  assertEquals(res, undefined);
});

Deno.test("decode_varint too long throws error", () => {
  const longVarint = new Uint8Array(10);
  longVarint.fill(0x80);
  const [res, status] = decodeVarInt(longVarint);
  assertEquals(status, Status.InvalidMessage);
  assertEquals(res, undefined);
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
  const [decodedDate, status] = dec.readDate();
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decodedDate.getTime(), date.getTime());
});

Deno.test("Decoder readDate", () => {
  const date = new Date();
  const enc = new Encoder();
  enc.writeDate(date);
  const data = enc.result();
  const dec = new Decoder(data);
  const [decodedDate, status] = dec.readDate();
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decodedDate.getTime(), date.getTime());
});

Deno.test("Date roundtrip sequential", () => {
  const date1 = new Date(1000);
  const date2 = new Date(2000);
  const enc = new Encoder();
  enc.writeDate(date1);
  enc.writeDate(date2);
  const data = enc.result();
  const dec = new Decoder(data);
  const [decodedDate1, s1] = dec.readDate();
  assertEquals(s1, Status.Success);
  const [decodedDate2, s2] = dec.readDate();
  assertEquals(s2, Status.Success);
  assertEquals(decodedDate1, date1);
  assertEquals(decodedDate2, date2);
});

Deno.test("Decoder readDate not enough data", () => {
  const data = new Uint8Array(7); // less than 8
  const dec = new Decoder(data);
  const [date, status] = dec.readDate();
  assertEquals(status, Status.MissingBody);
  assertEquals(date, undefined);
});

Deno.test("Decoder fromResponse", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));
  const decoder = await Decoder.fromResponse(response);
  const [bytes, status] = decoder.readBytes(3);
  assertEquals(status, Status.Success);
  assertEquals(bytes, new Uint8Array([1, 2, 3]));
});
