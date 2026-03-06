import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { peekItemHeadCodec } from "../../shared/codecs/peekItemHead.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("peekItemHead roundtrip", () => {
  const original = {
    sig: new Uint8Array(64).fill(0x33),
    kdm: new Uint8Array(8).fill(0x44),
    headCph: new Uint8Array([10, 11, 12]),
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(peekItemHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.sig, original.sig);
  assertEquals(decoded.kdm, original.kdm);
  assertEquals(decoded.headCph, original.headCph);
  assertEquals(dec.done(), true);
});

Deno.test("peekItemHead decode short input", () => {
  const short = new Uint8Array(30); // Less than minimum size (64 + 8 + 1 + 0)
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(peekItemHeadCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("peekItemHead decode invalid sig length", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(32)); // Wrong sig length
  enc.writeBytes(new Uint8Array(8));
  enc.writeVarBytes(new Uint8Array([1]));
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(peekItemHeadCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("peekItemHead decode invalid kdm length", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(64));
  enc.writeBytes(new Uint8Array(4)); // Wrong kdm length
  enc.writeVarBytes(new Uint8Array([1]));
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(peekItemHeadCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("peekItemHead with empty headCph", () => {
  const original = {
    sig: new Uint8Array(64).fill(0),
    kdm: new Uint8Array(8).fill(0),
    headCph: new Uint8Array(0),
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(peekItemHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.headCph.length, 0);
  assertEquals(dec.done(), true);
});

Deno.test("peekItemHead with large headCph", () => {
  const original = {
    sig: new Uint8Array(64).fill(0xaa),
    kdm: new Uint8Array(8).fill(0xbb),
    headCph: new Uint8Array(1000).fill(0xcc),
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(peekItemHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.headCph.length, 1000);
  assertEquals(decoded.headCph[0], 0xcc);
  assertEquals(dec.done(), true);
});
