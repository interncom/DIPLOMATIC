import { assertEquals } from "jsr:@std/assert@0.223.0";
import { Decoder } from "../../shared/codec.ts";
import { authTimestampCodec } from "../../shared/codecs/authTimestamp.ts";

Deno.test("authTimestampCodec with invalid data length", () => {
  const shortEncoded = new Uint8Array(90); // less than 96 (32+64+8)
  try {
    const dec = new Decoder(shortEncoded);
    authTimestampCodec.decode(dec);
    throw new Error("Should have thrown");
  } catch (e) {
    assertEquals(
      (e as Error).message,
      "Not enough data to read requested bytes",
    );
  }
});
