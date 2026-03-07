import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { authTimestampCodec } from "../../shared/codecs/authTimestamp.ts";
import { Status } from "../../shared/consts.ts";
import type { PublicKey } from "../../shared/types.ts";

Deno.test("authTimestamp roundtrip", () => {
  const original: Parameters<typeof authTimestampCodec.encode>[1] = {
    pubKey: new Uint8Array(32).fill(0xaa) as PublicKey,
    sig: new Uint8Array(64).fill(0xbb),
    timestamp: new Date(1234567890123),
  };
  const enc = new Encoder();
  enc.writeStruct(authTimestampCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(authTimestampCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.pubKey, original.pubKey);
  assertEquals(decoded.sig, original.sig);
  assertEquals(decoded.timestamp.getTime(), original.timestamp.getTime());
  assertEquals(dec.done(), true);
});

Deno.test("authTimestamp decode short input", () => {
  const short = new Uint8Array(30); // Less than minimum size
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(authTimestampCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("authTimestamp decode invalid pubKey length", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(16)); // Wrong pubKey length
  enc.writeBytes(new Uint8Array(64));
  enc.writeDate(new Date());
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(authTimestampCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});

Deno.test("authTimestamp decode invalid sig length", () => {
  const enc = new Encoder();
  enc.writeBytes(new Uint8Array(32));
  enc.writeBytes(new Uint8Array(32)); // Wrong sig length
  enc.writeDate(new Date());
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(authTimestampCodec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});
