import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { DiplomaticServer } from "../../shared/server2.ts";
import memStorage from "../src/storage/memory.ts";
import libsodiumCrypto from "../src/crypto.ts";
import denoMsgpack from "../src/codec.ts";
import DiplomaticClientAPI from "../../shared/client2.ts";
import { IWebsocketNotifier } from "../../shared/types.ts";
import { genInsert } from "../../shared/message.ts";

// Server config.
const port = 3331;
const hostID = "id123456";
const registrationToken = "tok123";

// Client config.
const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();

// Derivation index for host key pair.
// Increments as part of host keypair rotation.
const hostIdx = 0;

const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(
  seed,
  hostID,
  hostIdx,
);

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

  // Test PUSH
  const content = denoMsgpack.encode("test operation data");
  const op1 = await genInsert(new Date(), content, libsodiumCrypto);
  const op2 = await genInsert(new Date(), content, libsodiumCrypto);
  const ops = [op1, op2];
  await t.step("POST /ops", async () => {
    const result = await client.push(
      url,
      ops,
      seed,
      hostID,
      hostIdx,
      new Date(),
    );
    assertEquals(result.length, 2); // Should return status-hash pairs for each envelope
    for (const res of result) {
      assertEquals(res.status, 0);
      assertEquals(res.hash.length, 32);
    }
  });

  await httpServer.shutdown();
});
