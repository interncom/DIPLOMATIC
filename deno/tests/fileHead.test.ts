import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { fileHeadCodec } from "../../shared/codecs/fileHead.ts";
import { Status } from "../../shared/consts.ts";
import type { Hash } from "../../shared/types.ts";

Deno.test("fileHead roundtrip", () => {
  const original = {
    lbl: "test-label",
    idx: 42,
    num: 123,
    hsh: new Uint8Array(32).fill(0xee) as Hash,
    sig: new Uint8Array(64).fill(0xff),
  };
  const enc = new Encoder();
  enc.writeStruct(fileHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.lbl, original.lbl);
  assertEquals(decoded.idx, original.idx);
  assertEquals(decoded.num, original.num);
  assertEquals(decoded.hsh, original.hsh);
  assertEquals(decoded.sig, original.sig);
  assertEquals(dec.done(), true);
});

Deno.test("fileHead decode short input", () => {
  const short = new Uint8Array(10); // Less than minimum size
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(fileHeadCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("fileHead decode invalid hash length", () => {
  const enc = new Encoder();
  enc.writeVarString("label");
  enc.writeVarInt(1);
  enc.writeVarInt(1);
  enc.writeBytes(new Uint8Array(16)); // Wrong hash length
  enc.writeBytes(new Uint8Array(64));
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("fileHead decode invalid sig length", () => {
  const enc = new Encoder();
  enc.writeVarString("label");
  enc.writeVarInt(1);
  enc.writeVarInt(1);
  enc.writeBytes(new Uint8Array(32));
  enc.writeBytes(new Uint8Array(32)); // Wrong sig length
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("fileHead with empty label", () => {
  const original = {
    lbl: "",
    idx: 0,
    num: 0,
    hsh: new Uint8Array(32).fill(0) as Hash,
    sig: new Uint8Array(64).fill(0),
  };
  const enc = new Encoder();
  enc.writeStruct(fileHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.lbl, "");
  assertEquals(dec.done(), true);
});

Deno.test("fileHead with unicode label", () => {
  const original = {
    lbl: "测试标签",
    idx: 999,
    num: 1000,
    hsh: new Uint8Array(32).fill(0x55) as Hash,
    sig: new Uint8Array(64).fill(0x66),
  };
  const enc = new Encoder();
  enc.writeStruct(fileHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.lbl, original.lbl);
  assertEquals(decoded.idx, original.idx);
  assertEquals(decoded.num, original.num);
  assertEquals(dec.done(), true);
});
