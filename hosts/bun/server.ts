import libsodiumCrypto from "../../bun/src/crypto.ts";
import sqliteStorage from "../../bun/src/storage/sqlite.ts";
import { Clock } from "../../shared/clock.ts";
import { DiplomaticHTTPServer } from "../../shared/http/server.ts";

// Dummy notifier for bun demo, no websocket support
class DummyNotifier {
  async open() {
    return {
      send: () => 0, // Status.Success
      shut: () => 0,
      status: 0,
    };
  }
  async push() {}
  handle = async () => new Response("WebSockets not supported in bun demo", { status: 404 });
}

const dummyNotifier = new DummyNotifier();

const port = Number.parseInt(process.env.DIPLOMATIC_HOST_PORT || "31337");

const server = new DiplomaticHTTPServer(
  sqliteStorage,
  libsodiumCrypto,
  dummyNotifier,
  new Clock(),
);

console.log(`DIPLOMATIC PARCEL SERVICE ACTIVE on http://localhost:${port}`);
Bun.serve({ port, fetch: server.corsHandler });