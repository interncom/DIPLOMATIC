import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { peekItemCodec } from "../../shared/codecs/peekItem.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("peekItem roundtrip", () => {
  const original = {
    seq: 42,
    headCph: new Uint8Array([1, 2, 3, 4, 5]),
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(peekItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.headCph, original.headCph);
  assertEquals(dec.done(), true);
});

Deno.test("peekItem decode short input", () => {
  const short = new Uint8Array(0); // No data
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(peekItemCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("peekItem with empty headCph", () => {
  const original = {
    seq: 0,
    headCph: new Uint8Array(0),
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(peekItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.headCph.length, 0);
  assertEquals(dec.done(), true);
});

Deno.test("peekItem with large seq", () => {
  const original = {
    seq: 0x7fffffff,
    headCph: new Uint8Array([255, 254, 253]),
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(peekItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.seq, original.seq);
  assertEquals(dec.done(), true);
});
