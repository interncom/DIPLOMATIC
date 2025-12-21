import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { DiplomaticServer } from "../../shared/server.ts";
import memStorage from "../src/storage/memory.ts";
import libsodiumCrypto from "../src/crypto.ts";
import denoMsgpack from "../src/codec.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { IWebsocketNotifier } from "../../shared/types.ts";
import { genInsert, decodeOp, concat } from "../../shared/message.ts";
import { decodeEnvelope, type IEnvelope } from "../../shared/envelope.ts";
import { uint8ArraysEqual } from "../../shared/lib.ts";
import { Enclave } from "../../shared/enclave.ts";
import { MasterSeed } from "../../shared/types.ts";

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
      assertEquals(res.status, 0);
      assertEquals(res.hash.length, 32);
    }
  });

  await t.step("POST /pull", async () => {
    const hashes = result.map((r) => r.hash);
    const pulledEnvelopes = await client.pull(
      url,
      hashes,
      hostID,
      hostIdx,
      now,
    );
    assertEquals(pulledEnvelopes.length, 2);

    // Verify that pulled envelopes have the correct hashes and messages
    for (let i = 0; i < pulledEnvelopes.length; i++) {
      const env = pulledEnvelopes[i];
      assertEquals(uint8ArraysEqual(env.hsh, hashes[i]), true);
      const kdm = env.msg.slice(0, 8);
      const cipherOp = env.msg.slice(8);
      const encKey = await enclave.deriveFromKDM(kdm);
      const decrypted = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
        cipherOp,
        encKey,
      );
      const pulledOp = await decodeOp(decrypted);
      assertEquals(pulledOp.clk, ops[i].clk);
      assertEquals(
        uint8ArraysEqual(
          pulledOp.bod ?? new Uint8Array(),
          ops[i].bod ?? new Uint8Array(),
        ),
        true,
      );
      // Additional checks to exercise var-int encoding for ctr, eid, len
      assertEquals(pulledOp.ctr, ops[i].ctr);
      assertEquals(pulledOp.len, ops[i].len);
      assertEquals(uint8ArraysEqual(pulledOp.eid, ops[i].eid), true);
    }
  });

  await t.step("POST /peek", async () => {
    const peekedHeaders = await client.peek(url, 0, hostID, hostIdx, now);
    assertEquals(peekedHeaders.length, 2);
    // Optionally, verify the headers match the pushed ops' hashes
    for (let i = 0; i < peekedHeaders.length; i++) {
      assertEquals(
        uint8ArraysEqual(peekedHeaders[i].hsh, result[i].hash),
        true,
      );
    }
  });

  await httpServer.shutdown();
});
