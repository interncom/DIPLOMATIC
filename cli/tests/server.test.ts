import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

function extractUrl(str: string): string | null {
  const urlRegex = /(https?:\/\/[^\s]+)/;
  const matches = str.match(urlRegex);
  return matches?.[0] ?? null;
}

const serverID = "id123";

async function startServer(): Promise<{ proc: Deno.Process, url: URL } | undefined> {
  // NOTE: must run from cli dir.
  const p = Deno.run({
    cmd: ["deno", "run", "--allow-env", "--allow-net", "src/server.ts"],
    env: {
      DIPLOMATIC_ID: serverID,
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
    const response = await fetch(`${server.url}id`);
    const body = await response.text();
    assertEquals(body, serverID);
  } finally {
    server.proc.close();
    server.proc.stdout?.close();
    server.proc.stderr?.close();
  }
});
