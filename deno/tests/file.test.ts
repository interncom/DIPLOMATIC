import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { fileCodec } from "../../shared/codecs/file.ts";

import { Status } from "../../shared/consts.ts";
import type { Hash } from "../../shared/types.ts";

Deno.test("file roundtrip", () => {
  const head = {
    lbl: "test-label",
    idx: 42,
    num: 123,
    hsh: new Uint8Array(32).fill(0xee) as Hash,
    sig: new Uint8Array(64).fill(0xff),
  };
  const original = {
    head,
    indexEnc: new Uint8Array([1, 2, 3, 4]),
    bodyEnc: new Uint8Array([5, 6, 7]),
  };
  const enc = new Encoder();
  enc.writeStruct(fileCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.head.lbl, original.head.lbl);
  assertEquals(decoded.head.idx, original.head.idx);
  assertEquals(decoded.head.num, original.head.num);
  assertEquals(decoded.head.hsh, original.head.hsh);
  assertEquals(decoded.head.sig, original.head.sig);
  assertEquals(decoded.indexEnc, original.indexEnc);
  assertEquals(decoded.bodyEnc, original.bodyEnc);
  assertEquals(dec.done(), true);
});

Deno.test("file decode short input", () => {
  const short = new Uint8Array(10); // Less than minimum size
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(fileCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("file decode invalid head", () => {
  const enc = new Encoder();
  enc.writeVarString(""); // Empty label
  enc.writeVarInt(0);
  enc.writeVarInt(0);
  enc.writeBytes(new Uint8Array(16)); // Wrong hash length
  enc.writeBytes(new Uint8Array(64));
  enc.writeVarBytes(new Uint8Array([1]));
  enc.writeVarBytes(new Uint8Array([2]));
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(fileCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("file with empty encodings", () => {
  const head = {
    lbl: "",
    idx: 0,
    num: 0,
    hsh: new Uint8Array(32).fill(0) as Hash,
    sig: new Uint8Array(64).fill(0),
  };
  const original = {
    head,
    indexEnc: new Uint8Array(0),
    bodyEnc: new Uint8Array(0),
  };
  const enc = new Encoder();
  enc.writeStruct(fileCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.head.lbl, original.head.lbl);
  assertEquals(decoded.indexEnc.length, 0);
  assertEquals(decoded.bodyEnc.length, 0);
  assertEquals(dec.done(), true);
});
