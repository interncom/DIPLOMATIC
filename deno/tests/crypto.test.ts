import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("crypto", async () => {
  const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const [enclave, est] = Enclave.fromBytes(seed);
  if (est !== Status.Success) throw new Error(`enclave ${est}`);

  // Key stays inside the enclave; cipher is an opaque handle.
  const kdm = new Uint8Array(8).fill(0x42);
  const plaintext = new Uint8Array([0x12, 0x34]);
  const cipher = enclave.deriveCipher(kdm, "both");
  const [cph, cst] = await cipher.encrypt(plaintext);
  assertEquals(cst, Status.Success);
  const [dec, dst] = await cipher.decrypt(cph);
  assertEquals(dst, Status.Success);
  assertEquals(plaintext, dec);
});
