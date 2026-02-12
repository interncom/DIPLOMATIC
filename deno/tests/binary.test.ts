import { assertEquals, assertThrows } from "https://deno.land/std/testing/asserts.ts";
import { btob128, b128tob } from "../../shared/binary.ts";

Deno.test("btob128 empty array", () => {
  const result = btob128(new Uint8Array());
  assertEquals(result, "");
});

Deno.test("btob128 single byte", () => {
  const result = btob128(new Uint8Array([0]));
  assertEquals(result, "\x00\x00");
});

Deno.test("btob128 single byte max", () => {
  const result = btob128(new Uint8Array([255]));
  assertEquals(result, "\x7f\x01");
});

Deno.test("btob128 multiple bytes", () => {
  const result = btob128(new Uint8Array([170, 187]));
  assertEquals(result, "*w\x02");
});

Deno.test("b128tob empty string", () => {
  const result = b128tob("");
  assertEquals(result, new Uint8Array());
});

Deno.test("b128tob two chars", () => {
  const result = b128tob("\x00\x00");
  assertEquals(result, new Uint8Array([0]));
});

Deno.test("b128tob two chars max", () => {
  const result = b128tob("\x7f\x01");
  assertEquals(result, new Uint8Array([255]));
});

Deno.test("b128tob multiple chars", () => {
  const result = b128tob("*w\x02");
  assertEquals(result, new Uint8Array([170, 187]));
});

Deno.test("b128tob invalid char", () => {
  assertThrows(() => b128tob("\x80"), Error, "Invalid base128 character");
});

Deno.test("roundtrip empty", () => {
  const original = new Uint8Array();
  const encoded = btob128(original);
  const decoded = b128tob(encoded);
  assertEquals(decoded, original);
});

Deno.test("roundtrip single byte", () => {
  const original = new Uint8Array([42]);
  const encoded = btob128(original);
  const decoded = b128tob(encoded);
  assertEquals(decoded, original);
});

Deno.test("roundtrip multiple bytes", () => {
  const original = new Uint8Array([1, 2, 3, 4, 5]);
  const encoded = btob128(original);
  const decoded = b128tob(encoded);
  assertEquals(decoded, original);
});

Deno.test("roundtrip large data", () => {
  const original = new Uint8Array(100);
  for (let i = 0; i < 100; i++) original[i] = i % 256;
  const encoded = btob128(original);
  const decoded = b128tob(encoded);
  assertEquals(decoded, original);
});

// Test padding behavior: total bits not multiple of 7
Deno.test("btob128 padding - 1 byte (8 bits)", () => {
  const input = new Uint8Array([255]); // 8 bits
  const encoded = btob128(input);
  // 8 bits -> 2 chars: 7 bits + 1 bit (padded)
  assertEquals(encoded.length, 2);
  assertEquals(encoded.charCodeAt(0), 127); // 0x7f
  assertEquals(encoded.charCodeAt(1), 1);   // 0x01 (remaining bit)
});

Deno.test("btob128 padding - 2 bytes (16 bits)", () => {
  const input = new Uint8Array([255, 0]); // 16 bits
  const encoded = btob128(input);
  // 16 bits -> 3 chars: 7 + 7 + 2 bits
  assertEquals(encoded.length, 3);
  assertEquals(encoded.charCodeAt(0), 127); // 0x7f
  assertEquals(encoded.charCodeAt(1), 1);   // 0x01
  assertEquals(encoded.charCodeAt(2), 0);   // 0x00
});

Deno.test("roundtrip padding case", () => {
  const input = new Uint8Array([1]); // 8 bits, not multiple of 7
  const encoded = btob128(input);
  const decoded = b128tob(encoded);
  assertEquals(decoded, input);
});

Deno.test("roundtrip padding case 2", () => {
  const input = new Uint8Array([255, 255, 255]); // 24 bits, 24/7 ≈ 3.42, so leftover
  const encoded = btob128(input);
  const decoded = b128tob(encoded);
  assertEquals(decoded, input);
});