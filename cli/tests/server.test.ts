import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { encode } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import { IKeyPair, deriveAuthKeyPair, generateSeed, sign } from "../src/auth.ts";
import type { IOperationRequest, IRegistrationRequest } from "../src/types.ts";
import { btoh } from "../src/lib.ts";

function extractUrl(str: string): string | null {
  const urlRegex = /(https?:\/\/[^\s]+)/;
  const matches = str.match(urlRegex);
  return matches?.[0] ?? null;
}

// Server config.
const hostID = "id123";
const registrationToken = "tok123";

// Client config.
const seed = generateSeed();
const keyPair = deriveAuthKeyPair(hostID, seed);


async function startServer(): Promise<{ proc: Deno.Process, url: URL } | undefined> {
  // NOTE: must run from cli dir.
  const p = Deno.run({
    cmd: ["deno", "run", "--allow-env", "--allow-net", "src/server.ts"],
    env: {
      DIPLOMATIC_ID: hostID,
      DIPLOMATIC_REG_TOKEN: registrationToken,
    },
    stdout: "piped",
    stderr: "piped",
  });

  // Wait for the server to print its ready message
  const reader = p.stdout.readable.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value);
    const url = extractUrl(output);
    if (url) {
      reader.releaseLock();
      return { proc: p, url: new URL(url) }
    }
  }
}

function testEndpoint(testFunc: (url: URL) => Promise<void>): () => Promise<void> {
  return async () => {
    const server = await startServer();
    if (!server) {
      throw "a fit";
    }

    try {
      await testFunc(server.url);
    } finally {
      server.proc.close();
      server.proc.stdout?.close();
      server.proc.stderr?.close();
    }
  }
}

Deno.test("GET /id", testEndpoint(async (url) => {
  url.pathname = "/id";
  const response = await fetch(url, { method: "GET" });
  const body = await response.text();
  assertEquals(body, hostID);
}));

const pubKey = keyPair.publicKey;

Deno.test("POST /users", testEndpoint(async (url) => {
  url.pathname = "/users";
  const req: IRegistrationRequest = {
    token: registrationToken,
    pubKey, // TODO: check for valid pubKey length, server-side.
  };
  const reqPack = encode(req);

  const response = await fetch(url, { method: "POST", body: reqPack });
  await response.body?.cancel()
  assertEquals(response.status, 200);
}));

Deno.test("POST /ops", testEndpoint(async (url) => {
  const regReq: IRegistrationRequest = {
    token: registrationToken,
    pubKey, // TODO: check for valid pubKey length, server-side.
  };
  const regReqPack = encode(regReq);
  url.pathname = "/users";
  const regResp = await fetch(url, { method: "POST", body: regReqPack });
  await regResp.body?.cancel();

  const req: IOperationRequest = {
    cipher: new Uint8Array([0xFE, 0xFE]),
  };
  const reqPack = encode(req);

  const sig = sign(req.cipher, keyPair);
  const sigHex = btoh(sig);
  const keyHex = btoh(pubKey);

  url.pathname = "/ops";
  const response = await fetch(url, {
    method: "POST", body: reqPack, headers: {
      "X-DIPLOMATIC-SIG": sigHex,
      "X-DIPLOMATIC-KEY": keyHex,
    }
  });
  if (!response.ok) {
    console.log(await response.text())
  }
  await response.body?.cancel()
  assertEquals(response.status, 200);
}));
