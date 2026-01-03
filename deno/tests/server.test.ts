import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { Status, tsAuthSize } from "../../shared/consts.ts";
import { genInsert } from "../../shared/message.ts";
import { DiplomaticServer } from "../../shared/server.ts";
import { IWebsocketNotifier } from "../../shared/types.ts";
import denoMsgpack from "../src/codec.ts";
import libsodiumCrypto from "../src/crypto.ts";
import memStorage from "../src/storage/memory.ts";

import { Encoder } from "../../shared/codec.ts";
import { Enclave } from "../../shared/enclave.ts";
import { MasterSeed } from "../../shared/types.ts";
import { MockClock } from "../../shared/clock.ts";

// Server config.
const port = 3331;
const hostID = "id123456";

// Client config.
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);

// Derivation index for host key pair.
// Increments as part of host keypair rotation.
const idx = 0;

const hostKDM = await enclave.derive(hostID, idx);
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(hostKDM);
const pubKeyHash = await libsodiumCrypto.sha256Hash(keyPair.publicKey);
const suffix = btoa(String.fromCharCode(...pubKeyHash.slice(0, 4)));
const expectedHostID = hostID + "-" + suffix;

Deno.test("server", async (t) => {
  const websocketHandler: IWebsocketNotifier = {
    handler: async () => new Response(),
    notify: async () => {},
  };

  // Use a consistent now Date for all operations and auth
  const now = new Date();
  const clock = new MockClock(now);

  const server = new DiplomaticServer(
    hostID,
    memStorage,
    libsodiumCrypto,
    websocketHandler,
    clock,
  );
  const httpServer = Deno.serve({ port }, server.corsHandler);

  if (!server) {
    throw "a fit";
  }
  const url = new URL(`http://localhost:${port}`);
  const client = new DiplomaticClientAPI(
    enclave,
    libsodiumCrypto,
    url,
    idx,
    clock,
  );

  await t.step("POST /users", async () => {
    await client.register(hostID);
  });

  // Test PUSH
  const content = denoMsgpack.encode("test operation data");
  const op1 = await genInsert(now, content, libsodiumCrypto);
  const op2 = await genInsert(now, content, libsodiumCrypto);
  const ops = [op1, op2];
  let result: Array<{ status: number; hash: Uint8Array }>;
  await t.step("POST /ops", async () => {
    result = [...(await client.push(ops, hostID))];
    assertEquals(result.length, 2); // Should return status-hash pairs for each bag
    for (const res of result) {
      assertEquals(res.status, Status.Success);
      assertEquals(res.hash.length, 32);
    }
  });

  await t.step("POST /pull", async () => {
    const hashes = result.map((r) => r.hash);
    const pulledItems = [
      ...(await client.pull(hashes, hostID)),
    ];
    assertEquals(pulledItems.length, 2);

    // Verify item structure (integration test, skip decryption)
    for (const item of pulledItems) {
      assertEquals(item.hash.length, 32);
      assert(item.bodyCph.length >= 0);
    }
  });

  await t.step("POST /peek", async () => {
    const peekedHeaders = [
      ...(await client.peek(new Date(0), hostID)),
    ];
    assertEquals(peekedHeaders.length, 2);
    // Verify header structure
    for (const header of peekedHeaders) {
      assertEquals(header.hash.length, 32);
      assert(header.recordedAt instanceof Date);
      assert(header.headCph.length > 0);
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
