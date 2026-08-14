import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("crypto", async () => {
  const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const [enclave, est] = Enclave.fromBytes(seed);
  if (est !== Status.Success || enclave === undefined) {
    throw new Error(`enclave ${est}`);
  }

  // Key stays inside the enclave; cipher is an opaque handle.
  const kdm = new Uint8Array(8).fill(0x42);
  const plaintext = new Uint8Array([0x12, 0x34]);
  const cipher = enclave.deriveCipher(kdm, "both");
  const cph = await cipher.encrypt(plaintext);
  const dec = await cipher.decrypt(cph);
  assertEquals(plaintext, dec);
});
