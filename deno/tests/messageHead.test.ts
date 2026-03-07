import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import {
  messageHeadCodec,
  minimalMessageHeadCodec,
} from "../../shared/codecs/messageHead.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("messageHead roundtrip with hash", () => {
  const [eid, eidStat] = makeEID({
    id: new Uint8Array(16).fill(0x11),
    ts: new Date(1000000),
  });
  assertEquals(eidStat, Status.Success);
  if (eidStat !== Status.Success) return;

  const original = {
    eid,
    off: 100,
    ctr: 200,
    len: 300,
    hsh: new Uint8Array(32).fill(0x22),
  };
  const enc = new Encoder();
  enc.writeStruct(messageHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(messageHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.eid, original.eid);
  assertEquals(decoded.off, original.off);
  assertEquals(decoded.ctr, original.ctr);
  assertEquals(decoded.len, original.len);
  assertEquals(decoded.hsh, original.hsh);
  assertEquals(dec.done(), true);
});

Deno.test("messageHead roundtrip without hash", () => {
  const [eid, eidStat] = makeEID({
    id: new Uint8Array(16).fill(0x33),
    ts: new Date(2000000),
  });
  assertEquals(eidStat, Status.Success);
  if (eidStat !== Status.Success) return;

  const original = {
    eid,
    off: 0,
    ctr: 1,
    len: 0,
    hsh: undefined,
  };
  const enc = new Encoder();
  enc.writeStruct(messageHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(messageHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.eid, original.eid);
  assertEquals(decoded.off, original.off);
  assertEquals(decoded.ctr, original.ctr);
  assertEquals(decoded.len, original.len);
  assertEquals(decoded.hsh, original.hsh);
  assertEquals(dec.done(), true);
});

Deno.test("minimalMessageHead roundtrip", () => {
  const [eid, eidStat] = makeEID({
    id: new Uint8Array(16).fill(0x44),
    ts: new Date(3000000),
  });
  assertEquals(eidStat, Status.Success);
  if (eidStat !== Status.Success) return;

  const original = {
    eid,
    off: 500,
    ctr: 600,
  };
  const enc = new Encoder();
  enc.writeStruct(minimalMessageHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(minimalMessageHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.eid, original.eid);
  assertEquals(decoded.off, original.off);
  assertEquals(decoded.ctr, original.ctr);
  assertEquals(dec.done(), true);
});

Deno.test("messageHead decode short input", () => {
  const short = new Uint8Array(5); // Less than minimum size
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(messageHeadCodec);
  assertEquals(status, Status.InvalidMessage);
  assertEquals(result, undefined);
});

Deno.test("messageHead decode invalid eid", () => {
  const enc = new Encoder();
  enc.writeVarBytes(new Uint8Array(0)); // Empty eid
  enc.writeVarInt(0);
  enc.writeVarInt(0);
  enc.writeVarInt(0);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(messageHeadCodec);
  assertEquals(status, Status.InvalidMessage); // Because eidCodec will fail on empty id
  assertEquals(result, undefined);
});

Deno.test("messageHead decode with hash but len=0", () => {
  const [eid, eidStat] = makeEID({
    id: new Uint8Array(16).fill(0x55),
    ts: new Date(0),
  });
  assertEquals(eidStat, Status.Success);
  if (eidStat !== Status.Success) return;

  const enc = new Encoder();
  enc.writeVarBytes(eid);
  enc.writeVarInt(0);
  enc.writeVarInt(0);
  enc.writeVarInt(0); // len=0, so no hash
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(messageHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.hsh, undefined);
});
