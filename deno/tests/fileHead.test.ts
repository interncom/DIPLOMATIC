// Round-trip and rejection tests for the export file header.

import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import {
  fileHeadCodec,
  fileHeadPreimage,
} from "../../shared/codecs/fileHead.ts";
import { hashBytes, hshBytes, sigBytes, Status } from "../../shared/consts.ts";
import type { Hash } from "../../shared/types.ts";

const hsh = new Uint8Array(hshBytes).fill(0xee) as Hash;
const sig = new Uint8Array(sigBytes).fill(0xff);

Deno.test("fileHead roundtrip", () => {
  const original = {
    nonce: new Uint8Array(hashBytes).fill(0x11),
    realms: [{
      realm: { label: "notes", index: 2 },
      num: 3,
      hsh,
    }],
    hsh,
    sig,
  };
  const enc = new Encoder();
  enc.writeStruct(fileHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assert(bytesEqual(decoded.nonce, original.nonce));
  assertEquals(decoded.realms.length, 1);
  const row = decoded.realms[0];
  if (row === undefined) throw new Error("realm");
  assertEquals(row.realm.label, "notes");
  assertEquals(row.realm.index, 2);
  assertEquals(row.num, 3);
  assert(bytesEqual(row.hsh, hsh));
  assertEquals(decoded.hsh, original.hsh);
  assertEquals(decoded.sig, original.sig);
  assertEquals(dec.done(), true);

  const [pre, pst] = fileHeadPreimage(original.nonce, original.realms);
  assertEquals(pst, Status.Success);
  if (pst !== Status.Success) return;
  const tail = hshBytes + sigBytes;
  assert(bytesEqual(pre, encoded.subarray(0, encoded.length - tail)));
});

Deno.test("fileHead empty directory", () => {
  const original = {
    nonce: new Uint8Array(hashBytes).fill(0x11),
    realms: [],
    hsh,
    sig,
  };
  const enc = new Encoder();
  assertEquals(enc.writeStruct(fileHeadCodec, original), Status.Success);
  const encoded = enc.result();
  const [decoded, status] = fileHeadCodec.decode(new Decoder(encoded));
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.realms.length, 0);
  const [pre, pst] = fileHeadPreimage(original.nonce, []);
  assertEquals(pst, Status.Success);
  if (pst !== Status.Success) return;
  assert(
    bytesEqual(pre, encoded.subarray(0, encoded.length - hshBytes - sigBytes)),
  );
});

Deno.test("fileHead decode short input", () => {
  const short = new Uint8Array(10);
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(fileHeadCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("fileHead decode invalid hash length", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(hashBytes));
  enc.writeVarInt(0);
  enc.writeBytes(new Uint8Array(16));
  enc.writeBytes(new Uint8Array(sigBytes));
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("fileHead decode invalid sig length", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(hashBytes));
  enc.writeVarInt(0);
  enc.writeBytes(new Uint8Array(hshBytes));
  enc.writeBytes(new Uint8Array(32));
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(fileHeadCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("fileHead rejects a short nonce", () => {
  const enc = new Encoder();
  const stat = enc.writeStruct(fileHeadCodec, {
    nonce: new Uint8Array(8),
    realms: [],
    hsh,
    sig,
  });
  assertEquals(stat, Status.InvalidParam);
});
