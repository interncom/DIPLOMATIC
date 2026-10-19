// Round-trip checks for the ent body codec.

import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder } from "../../shared/codec.ts";
import { encodeEnt, entCodec } from "../../shared/codecs/ent.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("encodeEnt minimum upsert is two zero bytes", () => {
  const [bod, st] = encodeEnt({});
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  assertEquals(bod, new Uint8Array([0, 0]));
});

Deno.test("entCodec roundtrip pid tags and body", () => {
  const [pid, sp] = makeEID({
    id: new Uint8Array(8).fill(0x11),
    ts: new Date(1_700_000_000_000),
  });
  assertEquals(sp, Status.Success);
  if (sp !== Status.Success) return;
  const body = new Uint8Array([1, 2, 3, 0, 9]);
  const [bod, st] = encodeEnt({
    pid,
    tags: ["a", "impl:x"],
    body,
  });
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  const dec = new Decoder(bod);
  const [ent, sd] = dec.readStruct(entCodec);
  assertEquals(sd, Status.Success);
  if (sd !== Status.Success) return;
  assertEquals(dec.done(), true);
  assertEquals(bytesEqual(ent.pid ?? new Uint8Array(), pid), true);
  assertEquals(ent.tags, ["a", "impl:x"]);
  assertEquals(ent.body, body);
  const got = ent.body;
  if (got === undefined) return;
  assertEquals(got.buffer, bod.buffer);
  assertEquals(got.byteOffset, bod.byteLength - got.byteLength);
});

Deno.test("entCodec omits empty pid tags and body", () => {
  const [bod, st] = encodeEnt({
    tags: [],
    body: new Uint8Array(0),
  });
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  const dec = new Decoder(bod);
  const [ent, sd] = dec.readStruct(entCodec);
  assertEquals(sd, Status.Success);
  if (sd !== Status.Success) return;
  assertEquals(ent.pid, undefined);
  assertEquals(ent.tags, undefined);
  assertEquals(ent.body, undefined);
});

Deno.test("entCodec rejects a truncated frame", () => {
  const dec = new Decoder(new Uint8Array([0xff]));
  const [, st] = dec.readStruct(entCodec);
  assertEquals(st, Status.InvalidMessage);
});

Deno.test("entCodec rejects a tag count past the buffer", () => {
  const dec = new Decoder(new Uint8Array([0x00, 0x05]));
  const [, st] = dec.readStruct(entCodec);
  assertEquals(st, Status.InvalidMessage);
});

Deno.test("encodeEnt rejects a non-byte body", () => {
  const box: { body?: Uint8Array } = {};
  Object.assign(box, { body: "nope" });
  const [, st] = encodeEnt(box);
  assertEquals(st, Status.InvalidParam);
});
