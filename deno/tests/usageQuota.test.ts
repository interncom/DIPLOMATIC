import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { usageQuotaCodec } from "../../shared/codecs/usageQuota.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("usageQuota roundtrip with usage", () => {
  const original = {
    quota: 100,
    usage: 50,
  };
  const enc = new Encoder();
  enc.writeStruct(usageQuotaCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(usageQuotaCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.quota, original.quota);
  assertEquals(decoded.usage, original.usage);
  assertEquals(dec.done(), true);
});

Deno.test("usageQuota roundtrip without usage", () => {
  const original = {
    quota: 0,
    usage: undefined,
  };
  const enc = new Encoder();
  enc.writeStruct(usageQuotaCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(usageQuotaCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.quota, original.quota);
  assertEquals(decoded.usage, original.usage);
  assertEquals(dec.done(), true);
});

Deno.test("usageQuota decode short input", () => {
  const short = new Uint8Array(0); // No data
  const dec = new Decoder(short);
  const [result, status] = dec.readStruct(usageQuotaCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});

Deno.test("usageQuota with zero quota", () => {
  const original = {
    quota: 0,
    usage: undefined,
  };
  const enc = new Encoder();
  enc.writeStruct(usageQuotaCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(usageQuotaCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.quota, 0);
  assertEquals(decoded.usage, undefined);
  assertEquals(dec.done(), true);
});

Deno.test("usageQuota with large numbers", () => {
  const original = {
    quota: 0x7fffffff,
    usage: 0x7ffffffe,
  };
  const enc = new Encoder();
  enc.writeStruct(usageQuotaCodec, original);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(usageQuotaCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.quota, original.quota);
  assertEquals(decoded.usage, original.usage);
  assertEquals(dec.done(), true);
});

Deno.test("usageQuota decode missing usage when quota > 0", () => {
  const enc = new Encoder();
  enc.writeVarInt(100); // quota > 0
  // Missing usage
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(usageQuotaCodec);
  assert(status !== Status.Success);
  assertEquals(result, undefined);
});
