import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import libsodiumCrypto from "../src/crypto.ts";

Deno.test("crypto", async () => {
  const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const encKey = await libsodiumCrypto.deriveXSalsa20Poly1305Key(seed);

  const plaintext = new Uint8Array([0x12, 0x34]);
  const cipher = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(plaintext, encKey);
  const dec = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(cipher, encKey);
  assertEquals(plaintext, dec);
})
