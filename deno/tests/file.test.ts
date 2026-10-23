// Round-trip tests for the export file container.

import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { fileCodec } from "../../shared/codecs/file.ts";
import { hashBytes, hshBytes, sigBytes, Status } from "../../shared/consts.ts";
import type { Hash } from "../../shared/types.ts";

function head(realms: {
  realm: { label: string; index: number };
  num: number;
  hsh: Hash;
}[]) {
  return {
    nonce: new Uint8Array(hashBytes).fill(0x11),
    realms,
    hsh: new Uint8Array(hshBytes).fill(0xee) as Hash,
    sig: new Uint8Array(sigBytes).fill(0xff),
  };
}

Deno.test("file roundtrip", () => {
  const original = {
    head: head([{
      realm: { label: "notes", index: 1 },
      num: 2,
      hsh: new Uint8Array(hshBytes).fill(0xab) as Hash,
    }]),
    chunks: new Uint8Array([1, 2, 3, 4, 5]),
  };
  const enc = new Encoder();
  enc.writeStruct(fileCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assert(bytesEqual(decoded.head.nonce, original.head.nonce));
  assertEquals(decoded.head.hsh, original.head.hsh);
  assertEquals(decoded.head.sig, original.head.sig);
  assertEquals(decoded.head.realms.length, 1);
  const row = decoded.head.realms[0];
  const src = original.head.realms[0];
  if (row === undefined || src === undefined) throw new Error("realm");
  assertEquals(row.realm.label, src.realm.label);
  assertEquals(row.realm.index, src.realm.index);
  assertEquals(row.num, src.num);
  assert(bytesEqual(row.hsh, src.hsh));
  assertEquals(decoded.chunks, original.chunks);
  assertEquals(dec.done(), true);
});

Deno.test("file decode short input", () => {
  const short = new Uint8Array(10);
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(fileCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("file decode invalid head", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(hashBytes));
  enc.writeVarInt(0);
  enc.writeBytes(new Uint8Array(16));
  enc.writeBytes(new Uint8Array(sigBytes));
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(fileCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("file with empty encodings", () => {
  const original = {
    head: head([]),
    chunks: new Uint8Array(0),
  };
  const enc = new Encoder();
  enc.writeStruct(fileCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assert(bytesEqual(decoded.head.nonce, original.head.nonce));
  assertEquals(decoded.head.realms.length, 0);
  assertEquals(decoded.chunks.length, 0);
  assertEquals(dec.done(), true);
});
