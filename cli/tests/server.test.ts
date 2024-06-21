import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveAuthKeyPair, generateSeed } from "../src/auth.ts";
import DiplomaticClient from "../src/client.ts";

function extractUrl(str: string): string | null {
  const urlRegex = /(https?:\/\/[^\s]+)/;
  const matches = str.match(urlRegex);
  return matches?.[0] ?? null;
}

// Server config.
const hostID = "id123";
const port = "3311";
const registrationToken = "tok123";

// Client config.
const seed = generateSeed();
const keyPair = deriveAuthKeyPair(hostID, seed);

async function startServer(): Promise<{ proc: Deno.Process, url: URL } | undefined> {
  // NOTE: must run from cli dir.
  const p = Deno.run({
    cmd: ["deno", "run", "--allow-env", "--allow-net", "src/server.ts"],
    env: {
      DIPLOMATIC_HOST_ID: hostID,
      DIPLOMATIC_HOST_PORT: port,
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

  const client = new DiplomaticClient(url);

  const cipherOp = new Uint8Array([0xFE, 0xFE]);

  await t.step("GET /id", async () => {
    const id = await client.getHostID();
    assertEquals(id, hostID);
  });

  const pubKey = keyPair.publicKey;

  await t.step("POST /users", async () => {
    await client.register(pubKey, registrationToken);
  });

  let opPath: string;

  await t.step("POST /ops", async () => {
    opPath = await client.putDelta(cipherOp, keyPair);
    assertNotEquals(opPath.length, 0);
  });

  await t.step("GET /ops/:path", async () => {
    const respCipher = await client.getDelta(opPath, keyPair);
    assertEquals(respCipher, cipherOp);
  });

  await t.step("GET /ops?begin=", async () => {
    // Fetch ops in open-ended range.
    const t0 = new Date(0);
    const resp = await client.getDeltaPaths(t0, keyPair);
    assertEquals(resp.paths.length, 1);
    assertEquals(resp.paths[0], opPath);
    assertNotEquals(resp.fetchedAt, undefined);
  });

  server.proc.close();
  server.proc.stdout?.close();
  server.proc.stderr?.close();
});
