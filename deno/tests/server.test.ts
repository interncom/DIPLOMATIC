import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DiplomaticServer } from "../../shared/server.ts";
import memStorage from "../src/storage/memory.ts";
import libsodiumCrypto from "../src/crypto.ts";
import denoMsgpack from "../src/codec.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { IWebsocketNotifier } from "../../shared/types.ts";
import { btoh } from "../../shared/lib.ts";

// Server config.
const port = 3331;
const hostID = "id123";
const registrationToken = "tok123";

// Client config.
const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(seed, hostID);

Deno.test("server", async (t) => {
  const websocketHandler: IWebsocketNotifier = {
    handler: async () => new Response(),
    notify: async () => { },
  }
  const server = new DiplomaticServer(hostID, registrationToken, memStorage, denoMsgpack, libsodiumCrypto, websocketHandler);
  const httpServer = Deno.serve({ port }, server.corsHandler);

  if (!server) {
    throw "a fit";
  }
  const url = new URL(`http://localhost:${port}`);

  const client = new DiplomaticClientAPI(denoMsgpack, libsodiumCrypto);

  const cipherOp = new Uint8Array([0xFE, 0xFE]);

  await t.step("GET /id", async () => {
    const id = await client.getHostID(url);
    assertEquals(id, hostID);
  });

  const pubKey = keyPair.publicKey;

  await t.step("POST /users", async () => {
    await client.register(url, pubKey, registrationToken);
  });

  const opHash = await libsodiumCrypto.sha256Hash(cipherOp);

  await t.step("POST /ops", async () => {
    const opPath = await client.putDelta(url, cipherOp, keyPair);
    assertNotEquals(opPath.length, 0);
  });

  await t.step("GET /ops/:path", async () => {
    const respCipher = await client.getDelta(url, opHash, keyPair);
    assertEquals(respCipher, cipherOp);
  });

  await t.step("GET /ops?begin=", async () => {
    // Fetch ops in open-ended range.
    const t0 = new Date(0);
    const resp = await client.listDeltas(url, t0, keyPair);
    assertEquals(resp.deltas.length, 1);
    const sha256Hex = btoh(resp.deltas[0].sha256);
    assertEquals(sha256Hex, btoh(opHash));
    assertNotEquals(resp.fetchedAt, undefined);
  });

  await httpServer.shutdown();
});
