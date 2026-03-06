import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { pushItemCodec } from "../../shared/codecs/pushItem.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("pushItem roundtrip success", () => {
  const original = {
    idx: 1,
    status: Status.Success as Status.Success,
    seq: 42,
  };
  const enc = new Encoder();
  enc.writeStruct(pushItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(pushItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.idx, original.idx);
  assertEquals(decoded.status, original.status);
  assertEquals("seq" in decoded && decoded.seq, original.seq);
  assertEquals(dec.done(), true);
});

Deno.test("pushItem roundtrip failure", () => {
  const original = {
    idx: 2,
    status: Status.InvalidParam as Exclude<Status, Status.Success>,
  };
  const enc = new Encoder();
  enc.writeStruct(pushItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(pushItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.idx, original.idx);
  assertEquals(decoded.status, original.status);
  assertEquals("seq" in decoded, false);
  assertEquals(dec.done(), true);
});

Deno.test("pushItem decode short input", () => {
  const short = new Uint8Array(2); // Less than minimum size
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(pushItemCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("pushItem decode invalid status", () => {
  const enc = new Encoder();
  enc.writeVarInt(0);
  enc.writeBytes(new Uint8Array([255])); // Invalid status
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(pushItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(result.status, 255);
});

Deno.test("pushItem success without seq", () => {
  const enc = new Encoder();
  enc.writeVarInt(1);
  enc.writeBytes(new Uint8Array([0])); // Success
  // Missing seq
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(pushItemCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("pushItem with zero idx", () => {
  const original = {
    idx: 0,
    status: Status.Success as Status.Success,
    seq: 0,
  };
  const enc = new Encoder();
  enc.writeStruct(pushItemCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(pushItemCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.idx, 0);
  assertEquals("seq" in decoded && decoded.seq, 0);
  assertEquals(dec.done(), true);
});
