import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { IRegistrationRequest } from "../src/types.ts";
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

Deno.test("GET /id", async () => {
  const server = await startServer();
  if (!server) {
    throw "a fit";
  }

  try {
    const url = server.url;
    url.pathname = "/id";
    const response = await fetch(url, { method: "GET" });
    const body = await response.text();
    assertEquals(body, serverID);
  } finally {
    server.proc.close();
    server.proc.stdout?.close();
    server.proc.stderr?.close();
  }
});


Deno.test("POST /users", async () => {
  const server = await startServer();
  if (!server) {
    throw "a fit";
  }

  try {
    const req: IRegistrationRequest = {
      token: registrationToken,
      pubKey: new Uint8Array([0xFF]),
    };
    const reqPack = encode(req);

    const url = server.url;
    url.pathname = "/users";
    const response = await fetch(url, { method: "POST", body: reqPack });
    await response.body?.cancel()
    assertEquals(response.status, 200);
  } finally {
    server.proc.close();
    server.proc.stdout?.close();
    server.proc.stderr?.close();
  }
});
