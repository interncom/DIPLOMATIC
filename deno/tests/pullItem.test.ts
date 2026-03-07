import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { pullItemCodec } from "../../shared/codecs/pullItem.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("pullItem roundtrip", () => {
  const original = {
    seq: 55,
    bodyCph: new Uint8Array([12, 13, 14, 15]),
  };
  const enc = new Encoder();
  enc.writeStruct(pullItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(pullItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.bodyCph, original.bodyCph);
  assertEquals(dec.done(), true);
});

Deno.test("pullItem decode short input", () => {
  const short = new Uint8Array(0); // No data
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(pullItemCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("pullItem with empty bodyCph", () => {
  const original = {
    seq: 0,
    bodyCph: new Uint8Array(0),
  };
  const enc = new Encoder();
  enc.writeStruct(pullItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(pullItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.bodyCph.length, 0);
  assertEquals(dec.done(), true);
});

Deno.test("pullItem with large bodyCph", () => {
  const original = {
    seq: 99999,
    bodyCph: new Uint8Array(10000).fill(0xdd),
  };
  const enc = new Encoder();
  enc.writeStruct(pullItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(pullItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.bodyCph.length, 10000);
  assertEquals(decoded.bodyCph[0], 0xdd);
  assertEquals(dec.done(), true);
});

Deno.test("pullItem decode truncated bodyCph", () => {
  const enc = new Encoder();
  enc.writeVarInt(1);
  enc.writeVarInt(5); // bodyLen=5
  enc.writeBytes(new Uint8Array([1, 2, 3])); // Only 3 bytes
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(pullItemCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});
