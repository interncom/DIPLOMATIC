import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { nullKDM } from "../../shared/crypto/derivation.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("crypto", async () => {
  const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const [enclave, est] = Enclave.fromBytes(seed);
  if (est !== Status.Success) throw new Error(`enclave ${est}`);

  // Key stays inside the manager.
  const kdm = new Uint8Array(8).fill(0x42);
  const plaintext = new Uint8Array([0x12, 0x34]);
  const [bagMgr, bst] = await enclave.bagman(nullKDM, nullKDM);
  if (bst !== Status.Success) throw new Error(`bagman ${bst}`);
  const [cph, cst] = await bagMgr.encrypt(kdm, plaintext);
  assertEquals(cst, Status.Success);
  const [dec, dst] = await bagMgr.decrypt(kdm, cph);
  assertEquals(dst, Status.Success);
  assertEquals(plaintext, dec);
});
