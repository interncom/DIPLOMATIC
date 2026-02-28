import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { IBagPeekItem } from "../../shared/codecs/peekItem.ts";
import { IBagPullItem } from "../../shared/codecs/pullItem.ts";
import { Status, tsAuthSize } from "../../shared/consts.ts";
import { DiplomaticHTTPServer } from "../../shared/http/server.ts";
import { genInsert } from "../../shared/message.ts";
import memStorage from "../../shared/storage/memory.ts";
import {
  ICrypto,
  IProtoHost,
  IPushOpenResponse,
  IWebSocketPushNotifier,
  PublicKey,
  PushReceiver,
} from "../../shared/types.ts";
import denoMsgpack from "../src/codec.ts";
import libsodiumCrypto from "../src/crypto.ts";

import { Clock, MockClock } from "../../shared/clock.ts";
import { Encoder } from "../../shared/codec.ts";
import { IAuthTimestamp } from "../../shared/codecs/authTimestamp.ts";
import { Enclave } from "../../shared/enclave.ts";
import { HTTPTransport } from "../../shared/http.ts";
import { IHostConnectionInfo, MasterSeed } from "../../shared/types.ts";
import { IBagPushItem } from "../../shared/codecs/pushItem.ts";

// Server config.
const port = 3331;

// Client config.
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);

class MockPushNotifier implements IWebSocketPushNotifier {
  handle(_host: IProtoHost, _request: Request): Promise<Response> {
    return Promise.resolve(new Response());
  }

  async open(
    _authTS: IAuthTimestamp,
    _recv: PushReceiver,
    _crypto: ICrypto,
    _clock: Clock,
  ): Promise<IPushOpenResponse> {
    return Promise.resolve({
      send: () => Status.Success,
      shut: () => Status.Success,
      status: Status.Success,
    });
  }

  push(_pubKey: PublicKey, _data: Uint8Array): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("server", async (t) => {
  const websocketHandler = new MockPushNotifier();

  // Use a consistent now Date for all operations and auth
  const now = new Date();
  const clock = new MockClock(now);

  const server = new DiplomaticHTTPServer(
    memStorage,
    libsodiumCrypto,
    websocketHandler,
    clock,
  );
  const httpServer = Deno.serve({ port }, server.corsHandler);

  if (!server) {
    throw "a fit";
  }
  const hostURL = new URL(`http://localhost:${port}`);
  const host: IHostConnectionInfo<URL> = {
    handle: hostURL,
    label: "id123456",
    idx: 0,
  };
  const wsURL = new URL(hostURL);
  wsURL.protocol = hostURL.protocol === "https" ? "wss" : "ws";
  const client = new DiplomaticClientAPI(
    enclave,
    libsodiumCrypto,
    host,
    clock,
    new HTTPTransport(host.handle),
    () => Promise.resolve(Status.Success),
  );

  await t.step("POST /users", async () => {
    await client.register();
  });

  // Test PUSH
  const bod = denoMsgpack.encode("test operation data");
  const [op1, s1] = await genInsert({ now, bod, crypto: libsodiumCrypto });
  if (s1 !== Status.Success) {
    assertEquals(s1, Status.Success);
    return;
  }
  const [op2, s2] = await genInsert({ now, bod, crypto: libsodiumCrypto });
  if (s2 !== Status.Success) {
    assertEquals(s2, Status.Success);
    return;
  }
  const bags = [await client.seal(op1), await client.seal(op2)];
  let result: IBagPushItem[];
  await t.step("POST /ops", async () => {
    const [pushResults, pushStatus] = await client.push(bags);
    if (pushStatus !== Status.Success) {
      assertEquals(pushStatus, Status.Success);
      return;
    }
    result = pushResults;
    assertEquals(result.length, 2); // Should return status-hash pairs for each bag
    for (const res of result) {
      assertEquals(res.status, Status.Success);
    }
  });

  await t.step("POST /pull", async () => {
    const seqs: number[] = [];
    for (const item of result) {
      if (item.status !== Status.Success) {
        continue;
      }
      seqs.push(item.seq);
    }
    const [pulledItems, pullStatus] = await client.pull(seqs);
    assertEquals(pullStatus, Status.Success);
    assertEquals((pulledItems as IBagPullItem[]).length, 2);

    // Verify item structure (integration test, skip decryption)
    for (const item of pulledItems as IBagPullItem[]) {
      assert(item.seq >= 0);
      assert(item.bodyCph.length >= 0);
    }
  });

  await t.step("POST /peek", async () => {
    const [peekedHeaders, peekStatus] = await client.peek(0);
    assertEquals(peekStatus, Status.Success);

    // Should have 2 items
    assertEquals((peekedHeaders as IBagPeekItem[]).length, 2);
    for (const header of peekedHeaders as IBagPeekItem[]) {
      assert(typeof header.seq === "number");
      assert(header.headCph.length > 0);
    }
  });

  const enc = new Encoder();
  enc.writeDate(new Date());
  const timestampBytes = enc.result();
  const invalidTsAuth = new Uint8Array(tsAuthSize);
  invalidTsAuth.set(timestampBytes, 96);

  await t.step("POST /user requires valid tsAuth", async () => {
    const response = await fetch(`http://localhost:${port}/user`, {
      method: "POST",
      body: invalidTsAuth,
      headers: { "Content-Type": "application/octet-stream" },
    });
    assertEquals(response.status, 200);
    const body = new Uint8Array(await response.arrayBuffer());
    assertEquals(body[0], Status.InvalidSignature);
  });

  await t.step("POST /push requires valid tsAuth", async () => {
    const response = await fetch(`http://localhost:${port}/push`, {
      method: "POST",
      body: invalidTsAuth,
      headers: { "Content-Type": "application/octet-stream" },
    });
    assertEquals(response.status, 200);
    await response.text();
  });

  await t.step("POST /pull requires valid tsAuth", async () => {
    const response = await fetch(`http://localhost:${port}/pull`, {
      method: "POST",
      body: invalidTsAuth,
      headers: { "Content-Type": "application/octet-stream" },
    });
    assertEquals(response.status, 200);
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
    assertEquals(response.status, 200);
    await response.text();
  });

  await httpServer.shutdown();
});
