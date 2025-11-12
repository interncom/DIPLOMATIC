import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { DiplomaticServer } from "../../shared/server2.ts";
import memStorage from "../src/storage/memory.ts";
import libsodiumCrypto from "../src/crypto.ts";
import denoMsgpack from "../src/codec.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { IWebsocketNotifier } from "../../shared/types.ts";

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
    notify: async () => {},
  };
  const server = new DiplomaticServer(
    hostID,
    registrationToken,
    memStorage,
    denoMsgpack,
    libsodiumCrypto,
    websocketHandler,
  );
  const httpServer = Deno.serve({ port }, server.corsHandler);

  if (!server) {
    throw "a fit";
  }
  const url = new URL(`http://localhost:${port}`);

  const client = new DiplomaticClientAPI(denoMsgpack, libsodiumCrypto);

  await t.step("GET /id", async () => {
    const id = await client.getHostID(url);
    assertEquals(id, hostID);
  });

  const pubKey = keyPair.publicKey;

  await t.step("POST /users", async () => {
    await client.register(url, pubKey, registrationToken);
  });

  await httpServer.shutdown();
});
