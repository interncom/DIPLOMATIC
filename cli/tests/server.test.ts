import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import type { IRegistrationRequest } from "../src/types.ts";
import { encode } from "https://deno.land/x/msgpack@v1.4/mod.ts";

function extractUrl(str: string): string | null {
  const urlRegex = /(https?:\/\/[^\s]+)/;
  const matches = str.match(urlRegex);
  return matches?.[0] ?? null;
}

const serverID = "id123";
const registrationToken = "tok123";

async function startServer(): Promise<{ proc: Deno.Process, url: URL } | undefined> {
  // NOTE: must run from cli dir.
  const p = Deno.run({
    cmd: ["deno", "run", "--allow-env", "--allow-net", "src/server.ts"],
    env: {
      DIPLOMATIC_ID: serverID,
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

function testEndpoint(pathname: string, testFunc: (url: URL) => Promise<void>): () => Promise<void> {
  return async () => {
    const server = await startServer();
    if (!server) {
      throw "a fit";
    }

    const url = server.url;
    url.pathname = pathname;

    try {
      await testFunc(url);
    } finally {
      server.proc.close();
      server.proc.stdout?.close();
      server.proc.stderr?.close();
    }
  }
}

Deno.test("GET /id", testEndpoint("/id", async (url) => {
  const response = await fetch(url, { method: "GET" });
  const body = await response.text();
  assertEquals(body, serverID);
}));


Deno.test("POST /users", testEndpoint("/users", async (url) => {
  const req: IRegistrationRequest = {
    token: registrationToken,
    pubKey: new Uint8Array([0xFF]), // TODO: check for valid pubKey length, server-side.
  };
  const reqPack = encode(req);

  const response = await fetch(url, { method: "POST", body: reqPack });
  await response.body?.cancel()
  assertEquals(response.status, 200);
}));
