// Round-trip and rejection tests for an export realm directory record.

import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { fileRealmCodec } from "../../shared/codecs/fileRealm.ts";
import { kdmCodec } from "../../shared/codecs/kdm.ts";
import { hshBytes, Status } from "../../shared/consts.ts";
import { nullKDM } from "../../shared/crypto/derivation.ts";
import type { Hash } from "../../shared/types.ts";

const hsh = new Uint8Array(hshBytes).fill(0xab) as Hash;

Deno.test("fileRealm roundtrip", () => {
  const original = {
    realm: { label: "notes", index: 2 },
    num: 3,
    hsh,
  };
  const enc = new Encoder();
  assertEquals(enc.writeStruct(fileRealmCodec, original), Status.Success);
  const dec = new Decoder(enc.result());
  const [decoded, st] = dec.readStruct(fileRealmCodec);
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  assertEquals(dec.done(), true);
  assertEquals(decoded.realm.label, "notes");
  assertEquals(decoded.realm.index, 2);
  assertEquals(decoded.num, 3);
  assert(bytesEqual(decoded.hsh, hsh));
});

Deno.test("fileRealm rejects a zero count on encode", () => {
  const enc = new Encoder();
  const st = enc.writeStruct(fileRealmCodec, { realm: nullKDM, num: 0, hsh });
  assertEquals(st, Status.InvalidMessage);
});

Deno.test("fileRealm rejects a short hash", () => {
  const enc = new Encoder();
  const st = enc.writeStruct(fileRealmCodec, {
    realm: nullKDM,
    num: 1,
    hsh: new Uint8Array(16) as Hash,
  });
  assertEquals(st, Status.InvalidParam);
});

Deno.test("fileRealm rejects a zero count", () => {
  const enc = new Encoder();
  assertEquals(kdmCodec.encode(enc, nullKDM), Status.Success);
  assertEquals(enc.writeVarInt(0), Status.Success);
  const [row, st] = fileRealmCodec.decode(new Decoder(enc.result()));
  assertEquals(st, Status.InvalidMessage);
  assertEquals(row, undefined);
});
