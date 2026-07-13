#!/usr/bin/env bun
/**
 * Minimal live test for DIPLOMATIC WebSocket notifications against the
 * production Cloudflare host.
 *
 * Usage:
 *   DIP_HOST=https://sync-beta.interncom.org \
 *   DIP_SEED=<64-hex-chars> \
 *   bun scripts/test-live-ws.ts
 *
 * The script:
 *   - Initializes a client (registers user if needed)
 *   - Starts a WS listener via listen()
 *   - Performs a push
 *   - Verifies that a notification arrived over the WebSocket (not polling)
 */

import * as Diplomatic from "../cli/src/index.ts";

const seed = Diplomatic.loadSeedOrPanic("DIP_SEED");
const host = Diplomatic.loadHostOrPanic("DIP_HOST");

console.log("Testing live WS notifications against:", host.handle.toString());

const client = await Diplomatic.initCLIOrPanic({ seed, host });

let receivedNotif = false;
let notifBytes: Uint8Array | null = null;

console.log("Starting WS listener...");

const listenStat = await client.listen(async (bytes: Uint8Array) => {
  console.log(
    "🎉 RECEIVED NOTIFICATION OVER WEBSOCKET!",
    bytes.length,
    "bytes",
  );
  receivedNotif = true;
  notifBytes = bytes;
  return Diplomatic.Status.Success;
});

if (listenStat !== Diplomatic.Status.Success) {
  console.error("Failed to start listener:", Diplomatic.Status[listenStat]);
  process.exit(1);
}

// Wait until the WebSocket is actually open (the connect() returns early).
console.log("Waiting for WebSocket to open...");
for (let i = 0; i < 40; i++) {
  // Access internal transport listener (for this test only)
  const transport = (client as any)?.conn?.transport;
  const listener = transport?.listener;
  if (
    listener && typeof listener.connected === "function" && listener.connected()
  ) {
    console.log("WS is fully connected.");
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

// Give the server side time to have the socket registered in the DO
await new Promise((r) => setTimeout(r, 1000));

console.log(
  "WS listener is active. Sending a push to trigger a notification...",
);

// Send something that will cause a notification for this user.
const body = Diplomatic.msgpack.encode(
  `live-ws-test ${new Date().toISOString()}`,
);

const pushStat = await client.upsertSingletonSync("live-test", body);

if (pushStat !== Diplomatic.Status.Success) {
  console.error("Push failed:", Diplomatic.Status[pushStat]);
  process.exit(1);
}

console.log("Push accepted. Waiting for WS notification (up to 8s)...");

// Give the server + WS delivery a reasonable window.
await new Promise((r) => setTimeout(r, 8000));

// Control check: did the data at least arrive via normal API?
try {
  const [peekItems, peekStat] = await client.peek(0);
  if (peekStat === Diplomatic.Status.Success) {
    console.log(
      "Control peek found",
      peekItems?.length || 0,
      "item(s) for this user (data was stored).",
    );
  }
} catch (e) {
  console.log("Control peek failed (non-fatal):", (e as Error).message);
}

if (receivedNotif && notifBytes) {
  console.log(
    "✅ SUCCESS: WebSocket push notification worked on the live host!",
  );
  console.log("   Notification payload length:", notifBytes.length);
  process.exit(0);
} else {
  console.log("❌ FAILED: No notification arrived over WebSocket.");
  console.log(
    "   (Data may be present via peek/pull, but the live WS notifier path did not deliver.)",
  );
  process.exit(1);
}
