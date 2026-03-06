import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { notifItemCodec } from "../../shared/codecs/notifItem.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("notifItem roundtrip with bodyCph", () => {
  const original = {
    seq: 42,
    headCph: new Uint8Array([1, 2, 3, 4]),
    bodyCph: new Uint8Array([5, 6, 7]),
  };
  const enc = new Encoder();
  enc.writeStruct(notifItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(notifItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.headCph, original.headCph);
  assertEquals(decoded.bodyCph, original.bodyCph);
  assertEquals(dec.done(), true);
});

Deno.test("notifItem roundtrip without bodyCph", () => {
  const original = {
    seq: 99,
    headCph: new Uint8Array([10, 20, 30]),
    bodyCph: undefined,
  };
  const enc = new Encoder();
  enc.writeStruct(notifItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(notifItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.seq, original.seq);
  assertEquals(decoded.headCph, original.headCph);
  assertEquals(decoded.bodyCph, original.bodyCph);
  assertEquals(dec.done(), true);
});

Deno.test("notifItem with empty headCph", () => {
  const original = {
    seq: 0,
    headCph: new Uint8Array(0),
    bodyCph: new Uint8Array(0),
  };
  const enc = new Encoder();
  enc.writeStruct(notifItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(notifItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.headCph.length, 0);
  assertEquals(decoded.bodyCph?.length ?? 0, 0);
  assertEquals(dec.done(), true);
});

Deno.test("notifItem decode truncated bodyCph", () => {
  const enc = new Encoder();
  enc.writeVarInt(1);
  enc.writeVarBytes(new Uint8Array([1]));
  enc.writeVarInt(5); // bodyLen=5
  enc.writeBytes(new Uint8Array([1, 2, 3])); // Only 3 bytes
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(notifItemCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});
