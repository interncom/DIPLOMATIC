import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { decrypt, encrypt } from "../src/crypto.ts";
import { generateSeed } from "../src/auth.ts";
import { deriveEncryptionKey } from "../src/crypto.ts";

Deno.test("crypto", () => {
  const seed = generateSeed();
  const encKey = deriveEncryptionKey(seed);

  const plaintext = new Uint8Array([0x12, 0x34]);
  const cipher = encrypt(plaintext, encKey);
  const dec = decrypt(cipher, encKey);
  assertEquals(plaintext, dec);
})
