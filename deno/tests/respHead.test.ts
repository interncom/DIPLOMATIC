import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { respHeadCodec } from "../../shared/codecs/respHead.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("respHead roundtrip", () => {
  const stat = { quota: 1000, usage: 500 };
  const dyn = { quota: 2000, usage: 150 };
  const original = {
    status: Status.Success,
    timeRcvd: new Date(1000000),
    timeSent: new Date(1000001),
    subscription: {
      term: 86400000,
      elapsed: 3600000,
      stat,
      dyn,
    },
  };
  const enc = new Encoder();
  enc.writeStruct(respHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(respHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.status, original.status);
  assertEquals(decoded.timeRcvd.getTime(), original.timeRcvd.getTime());
  assertEquals(decoded.timeSent.getTime(), original.timeSent.getTime());
  assertEquals(decoded.subscription.term, original.subscription.term);
  assertEquals(decoded.subscription.elapsed, original.subscription.elapsed);
  assertEquals(
    decoded.subscription.stat.quota,
    original.subscription.stat.quota,
  );
  assertEquals(
    decoded.subscription.stat.usage,
    original.subscription.stat.usage,
  );
  assertEquals(decoded.subscription.dyn.quota, original.subscription.dyn.quota);
  assertEquals(decoded.subscription.dyn.usage, original.subscription.dyn.usage);
  assertEquals(dec.done(), true);
});

Deno.test("respHead decode short input", () => {
  const short = new Uint8Array(0); // No data
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(respHeadCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("respHead decode invalid status", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array([255])); // Invalid status
  enc.writeDate(new Date());
  enc.writeDate(new Date());
  enc.writeVarInt(0);
  enc.writeVarInt(0);
  // Missing quota structs
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(respHeadCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("respHead with zero term", () => {
  const stat = { quota: 0 };
  const dyn = { quota: 0 };
  const original = {
    status: Status.Success,
    timeRcvd: new Date(0),
    timeSent: new Date(0),
    subscription: {
      term: 0,
      elapsed: 0,
      stat,
      dyn,
    },
  };
  const enc = new Encoder();
  enc.writeStruct(respHeadCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(respHeadCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.subscription.stat.usage, undefined);
  assertEquals(decoded.subscription.dyn.usage, undefined);
  assertEquals(dec.done(), true);
});
