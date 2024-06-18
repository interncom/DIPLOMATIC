import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { decode, decodeStream, encode } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import { deriveAuthKeyPair, generateSeed, sign } from "../src/auth.ts";
import type { IOperationRequest, IRegistrationRequest } from "../src/types.ts";
import { btoh } from "../src/lib.ts";
import { assertNotEquals, assertNotMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

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

Deno.test("server", async (t) => {
  const server = await startServer();
  if (!server) {
    throw "a fit";
  }
  const url = server.url;

  const cipherOp = new Uint8Array([0xFE, 0xFE]);

  await t.step("GET /id", async () => {
    url.pathname = "/id";
    const response = await fetch(url, { method: "GET" });
    const body = await response.text();
    assertEquals(body, hostID);
  });

  const pubKey = keyPair.publicKey;

  await t.step("POST /users", async () => {
    url.pathname = "/users";
    const req: IRegistrationRequest = {
      token: registrationToken,
      pubKey, // TODO: check for valid pubKey length, server-side.
    };
    const reqPack = encode(req);

    const response = await fetch(url, { method: "POST", body: reqPack });
    await response.body?.cancel()
    assertEquals(response.status, 200);
  });

  let opPath: string;

  await t.step("POST /ops", async () => {
    const req: IOperationRequest = {
      cipher: cipherOp,
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
    opPath = await response.text();
    assertNotEquals(opPath.length, 0);
    assertEquals(response.status, 200);
  });

  await t.step("GET /ops/:path", async () => {
    // Fetch a specific op.
    url.pathname = `/ops/${opPath}`;
    const sig = sign(opPath, keyPair);
    const sigHex = btoh(sig);
    const keyHex = btoh(pubKey);
    const response = await fetch(url, {
      method: "GET", headers: {
        "X-DIPLOMATIC-SIG": sigHex,
        "X-DIPLOMATIC-KEY": keyHex,
      }
    });
    const respBuf = await response.arrayBuffer();
    const resp = decode(respBuf) as { cipher: Uint8Array };
    if (resp.cipher === undefined) {
      throw "Missing cipher";
    }
    assertEquals(resp.cipher, cipherOp);
    assertEquals(response.status, 200);
  });

  server.proc.close();
  server.proc.stdout?.close();
  server.proc.stderr?.close();
});
