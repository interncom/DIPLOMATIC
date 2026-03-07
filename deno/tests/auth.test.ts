import { assertEquals } from "jsr:@std/assert@0.223.0";
import { Decoder } from "../../shared/codec.ts";
import { authTimestampCodec } from "../../shared/codecs/authTimestamp.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("authTimestampCodec with invalid data length", () => {
  const shortEncoded = new Uint8Array(90); // less than 96 (32+64+8)
  const dec = new Decoder(shortEncoded);
  const [result, status] = authTimestampCodec.decode(dec);
  assertEquals(status, Status.OutOfBounds);
  assertEquals(result, undefined);
});
