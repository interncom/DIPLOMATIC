import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DiplomaticServer } from "../../shared/server.ts";
import memStorage from "../src/storage/memory.ts";
import libsodiumCrypto from "../src/crypto.ts";
import denoMsgpack from "../src/codec.ts";
import { IWebsocketNotifier, IRegistrationRequest, IOperationRequest } from "../../shared/types.ts";
import { btoh, htob } from "../../shared/lib.ts";

// Server config.
const port = 3332;
const hostID = crypto.randomUUID();
const registrationToken = crypto.randomUUID();

// Client config.
const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(seed, hostID);

Deno.test("http server", async (t) => {
  const websocketHandler: IWebsocketNotifier = {
    handler: async () => new Response(),
    notify: async () => { },
  }
  const server = new DiplomaticServer(hostID, registrationToken, memStorage, denoMsgpack, libsodiumCrypto, websocketHandler);
  const httpServer = Deno.serve({ port }, server.corsHandler);

  if (!server) {
    throw "a fit";
  }
  const baseUrl = `http://localhost:${port}`;

  const cipherOp = new Uint8Array([0xFE, 0xFE]);
  const opHash = await libsodiumCrypto.sha256Hash(cipherOp);
  const opHashHex = btoh(opHash);

  await t.step("GET /id", async (t) => {
    await t.step("success", async () => {
      const response = await fetch(`${baseUrl}/id`);
      assertEquals(response.status, 200);
      const id = await response.text();
      assertEquals(id, hostID);
    });
  });

  await t.step("POST /users", async (t) => {
    await t.step("success", async () => {
      const registrationReq: IRegistrationRequest = {
        token: registrationToken,
        pubKey: keyPair.publicKey,
      };
      const body = denoMsgpack.encode(registrationReq);

      const response = await fetch(`${baseUrl}/users`, {
        method: "POST",
        headers: {
          // "Content-Type": "application/octet-stream",
        },
        body,
      });
      assertEquals(response.status, 200);
      const result = await response.text();
      assertEquals(result, "");
    });

    await t.step("invalid token", async () => {
      const registrationReq: IRegistrationRequest = {
        token: "invalid-token",
        pubKey: keyPair.publicKey,
      };
      const body = denoMsgpack.encode(registrationReq);

      const response = await fetch(`${baseUrl}/users`, {
        method: "POST",
        headers: {
          // "Content-Type": "application/octet-stream",
        },
        body,
      });
      assertEquals(response.status, 401);
      const result = await response.text();
      assertEquals(result, "Unauthorized");
    });
  });

  await t.step("POST /ops", async (t) => {
    await t.step("success", async () => {
      const operationReq: IOperationRequest = {
        cipher: cipherOp,
      };
      const body = denoMsgpack.encode(operationReq);
      const signature = await libsodiumCrypto.signEd25519(cipherOp, keyPair.privateKey);

      const response = await fetch(`${baseUrl}/ops`, {
        method: "POST",
        headers: {
          // "Content-Type": "application/octet-stream",
          "X-DIPLOMATIC-KEY": btoh(keyPair.publicKey),
          "X-DIPLOMATIC-SIG": btoh(signature),
        },
        body,
      });
      assertEquals(response.status, 200);
      const result = await response.text();
      assertEquals(result, opHashHex);
    });

    await t.step("invalid signature", async () => {
      const operationReq: IOperationRequest = {
        cipher: cipherOp,
      };
      const body = denoMsgpack.encode(operationReq);
      const invalidSignature = new Uint8Array(64).fill(0);

      const response = await fetch(`${baseUrl}/ops`, {
        method: "POST",
        headers: {
          // "Content-Type": "application/octet-stream",
          "X-DIPLOMATIC-KEY": btoh(keyPair.publicKey),
          "X-DIPLOMATIC-SIG": btoh(invalidSignature),
        },
        body,
      });
      assertEquals(response.status, 401);
      const result = await response.text();
      assertEquals(result, "Invalid signature");
    });

    await t.step("unregistered public key", async () => {
      const fakeKeyPair = await libsodiumCrypto.deriveEd25519KeyPair(await libsodiumCrypto.gen256BitSecureRandomSeed(), hostID);
      const operationReq: IOperationRequest = {
        cipher: cipherOp,
      };
      const body = denoMsgpack.encode(operationReq);
      const signature = await libsodiumCrypto.signEd25519(cipherOp, fakeKeyPair.privateKey);

      const response = await fetch(`${baseUrl}/ops`, {
        method: "POST",
        headers: {
          // "Content-Type": "application/octet-stream",
          "X-DIPLOMATIC-KEY": btoh(fakeKeyPair.publicKey),
          "X-DIPLOMATIC-SIG": btoh(signature),
        },
        body,
      });
      assertEquals(response.status, 401);
      const result = await response.text();
      assertEquals(result, "Unauthorized");
    });
  });

  await t.step("GET /ops/:path", async (t) => {
    await t.step("success", async () => {
      const path = opHashHex;
      const signature = await libsodiumCrypto.signEd25519(new TextEncoder().encode(path), keyPair.privateKey);

      const response = await fetch(`${baseUrl}/ops/${opHashHex}`, {
        headers: {
          "X-DIPLOMATIC-KEY": btoh(keyPair.publicKey),
          "X-DIPLOMATIC-SIG": btoh(signature),
        },
      });
      assertEquals(response.status, 200);
      const result = denoMsgpack.decode(new Uint8Array(await response.arrayBuffer()));
      assertEquals(result.cipher, cipherOp);
    });

    await t.step("invalid signature", async () => {
      const invalidSignature = new Uint8Array(64).fill(0);

      const response = await fetch(`${baseUrl}/ops/${opHashHex}`, {
        headers: {
          "X-DIPLOMATIC-KEY": btoh(keyPair.publicKey),
          "X-DIPLOMATIC-SIG": btoh(invalidSignature),
        },
      });
      assertEquals(response.status, 401);
      const result = await response.text();
      assertEquals(result, "Invalid signature");
    });
  });

  await t.step("GET /ops?begin=", async (t) => {
    await t.step("success", async () => {
      const t0 = new Date(0).toISOString();
      const sigPath = `/ops%3Fbegin=${t0}`;
      const signature = await libsodiumCrypto.signEd25519(new TextEncoder().encode(sigPath), keyPair.privateKey);

      const response = await fetch(`${baseUrl}${sigPath}`, {
        headers: {
          "X-DIPLOMATIC-KEY": btoh(keyPair.publicKey),
          "X-DIPLOMATIC-SIG": btoh(signature),
        },
      });
      assertEquals(response.status, 200);
      const result = denoMsgpack.decode(new Uint8Array(await response.arrayBuffer()));
      assertEquals(result.deltas.length, 1);
      assertEquals(btoh(result.deltas[0].sha256), opHashHex);
      assertNotEquals(result.fetchedAt, undefined);
    });
  });

  await httpServer.shutdown();
});
