import { encode_varint, decode_varint } from "../../web/src/shared/varint.ts";
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std/testing/asserts.ts";

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
  const n = (2 ** 32) - 1;
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
