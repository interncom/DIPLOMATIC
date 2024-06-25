import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import DiplomaticClient from "../../shared/client.ts";
import { DiplomaticServer } from "../../shared/server.ts";
import memStorage from "../src/storage/memory.ts";
import libsodiumCrypto from "../src/crypto.ts";
import denoMsgpack from "../src/codec.ts";

// Server config.
const port = 3331;
const hostID = "id123";
const registrationToken = "tok123";

// Client config.
const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(seed, hostID);

Deno.test("server", async (t) => {
  const server = new DiplomaticServer(hostID, registrationToken, memStorage, denoMsgpack, libsodiumCrypto);
  const httpServer = Deno.serve({ port }, server.corsHandler);

  if (!server) {
    throw "a fit";
  }
  const url = new URL(`http://localhost:${port}`);

  const client = new DiplomaticClient(url, denoMsgpack, libsodiumCrypto);

  const cipherOp = new Uint8Array([0xFE, 0xFE]);

  await t.step("GET /id", async () => {
    const id = await client.getHostID();
    assertEquals(id, hostID);
  });

  const pubKey = keyPair.publicKey;

  await t.step("POST /users", async () => {
    await client.register(pubKey, registrationToken);
  });

  let opPath: string;

  await t.step("POST /ops", async () => {
    opPath = await client.putDelta(cipherOp, keyPair);
    assertNotEquals(opPath.length, 0);
  });

  await t.step("GET /ops/:path", async () => {
    const respCipher = await client.getDelta(opPath, keyPair);
    assertEquals(respCipher, cipherOp);
  });

  await t.step("GET /ops?begin=", async () => {
    // Fetch ops in open-ended range.
    const t0 = new Date(0);
    const resp = await client.getDeltaPaths(t0, keyPair);
    assertEquals(resp.paths.length, 1);
    assertEquals(resp.paths[0], opPath);
    assertNotEquals(resp.fetchedAt, undefined);
  });

  await httpServer.shutdown();
});
