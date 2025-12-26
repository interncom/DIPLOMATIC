import { assertEquals, assert } from "https://deno.land/std/testing/asserts.ts";
import { tsAuthSize } from "../../shared/consts.ts";
import { DiplomaticServer, Status } from "../../shared/server.ts";
import memStorage from "../src/storage/memory.ts";
import libsodiumCrypto from "../src/crypto.ts";
import denoMsgpack from "../src/codec.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { IWebsocketNotifier } from "../../shared/types.ts";
import { genInsert, decodeOp } from "../../shared/message.ts";
import { concat } from "../../shared/lib.ts";
import { decodeEnvelope, type IEnvelope } from "../../shared/envelope.ts";
import { uint8ArraysEqual } from "../../shared/lib.ts";
import { Enclave } from "../../shared/enclave.ts";
import { MasterSeed } from "../../shared/types.ts";
import { Encoder } from "../../shared/codec.ts";

// Server config.
const port = 3331;
const hostID = "id123456";

// Client config.
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);

// Derivation index for host key pair.
// Increments as part of host keypair rotation.
const hostIdx = 0;

const hostKDM = await enclave.derive(hostID, hostIdx);
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(hostKDM);

Deno.test("server", async (t) => {
  const websocketHandler: IWebsocketNotifier = {
    handler: async () => new Response(),
    notify: async () => {},
  };
  const server = new DiplomaticServer(
    hostID,
    memStorage,
    libsodiumCrypto,
    websocketHandler,
  );
  const httpServer = Deno.serve({ port }, server.corsHandler);

  if (!server) {
    throw "a fit";
  }
  const url = new URL(`http://localhost:${port}`);

  const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const client = new DiplomaticClientAPI(enclave, libsodiumCrypto);

  await t.step("GET /id", async () => {
    const id = await client.getHostID(url);
    assertEquals(id, hostID);
  });

  const pubKey = keyPair.publicKey;

  // Use a consistent now Date for all operations and auth
  const now = new Date();

  await t.step("POST /users", async () => {
    await client.register(url, hostID, hostIdx, now);
  });

  // Test PUSH
  const content = denoMsgpack.encode("test operation data");
  const op1 = await genInsert(now, content, libsodiumCrypto);
  const op2 = await genInsert(now, content, libsodiumCrypto);
  const ops = [op1, op2];
  let result: Array<{ status: number; hash: Uint8Array }>;
  await t.step("POST /ops", async () => {
    result = await client.push(url, ops, hostID, hostIdx, now);
    assertEquals(result.length, 2); // Should return status-hash pairs for each envelope
    for (const res of result) {
      assertEquals(res.status, Status.Success);
      assertEquals(res.hash.length, 32);
    }
  });

  await t.step("POST /pull", async () => {
    const hashes = result.map((r) => r.hash);
    const pulledItems = await client.pull(url, hashes, hostID, hostIdx, now);
    assertEquals(pulledItems.length, 2);

    // Verify item structure (integration test, skip decryption)
    for (const item of pulledItems) {
      assertEquals(item.hash.length, 32);
      assert(item.bodyCry.length >= 0);
    }
  });

  await t.step("POST /peek", async () => {
    const peekedHeaders = await client.peek(url, 0, hostID, hostIdx, now);
    assertEquals(peekedHeaders.length, 2);
    // Verify header structure
    for (const header of peekedHeaders) {
      assertEquals(header.hash.length, 32);
      assert(typeof header.recordedAt === "number");
      assert(header.headCry.length > 0);
    }
  });

  const nowMs = BigInt(Date.now());
  const timestampBytes = new Uint8Array(8);
  new DataView(timestampBytes.buffer).setBigUint64(0, nowMs, false);
  const invalidTsAuth = new Uint8Array(tsAuthSize);
  invalidTsAuth.set(timestampBytes, 96);

  await t.step("POST /users requires valid tsAuth", async () => {
    const response = await fetch(`http://localhost:${port}/users`, {
      method: "POST",
      body: invalidTsAuth,
      headers: { "Content-Type": "application/octet-stream" },
    });
    assertEquals(response.status, 401);
    await response.text();
  });

  await t.step("POST /ops requires valid tsAuth", async () => {
    const response = await fetch(`http://localhost:${port}/ops`, {
      method: "POST",
      body: invalidTsAuth,
      headers: { "Content-Type": "application/octet-stream" },
    });
    assertEquals(response.status, 401);
    await response.text();
  });

  await t.step("POST /pull requires valid tsAuth", async () => {
    const response = await fetch(`http://localhost:${port}/pull`, {
      method: "POST",
      body: invalidTsAuth,
      headers: { "Content-Type": "application/octet-stream" },
    });
    assertEquals(response.status, 401);
    await response.text();
  });

  await t.step("POST /peek requires valid tsAuth", async () => {
    const peekUrl = new URL(`http://localhost:${port}/peek`);
    const enc = new Encoder();
    enc.writeBytes(invalidTsAuth);
    enc.writeVarInt(0);
    const body = enc.result().slice();
    const response = await fetch(peekUrl.toString(), {
      method: "POST",
      body,
      headers: { "Content-Type": "application/octet-stream" },
    });
    assertEquals(response.status, 401);
    await response.text();
  });

  await httpServer.shutdown();
});
