import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { Enclave } from "../../shared/enclave.ts";

Deno.test("crypto", async () => {
  const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const enclave = new Enclave(seed, libsodiumCrypto);

  // Create some simple KDM (key derivation material)
  const kdm = new Uint8Array(8).fill(0x42);
  const encKey = await enclave.deriveFromKDM(kdm);

  const plaintext = new Uint8Array([0x12, 0x34]);
  const cipher = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(
    plaintext,
    encKey,
  );
  const dec = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
    cipher,
    encKey,
  );
  assertEquals(plaintext, dec);
});
