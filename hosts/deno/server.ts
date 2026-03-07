import libsodiumCrypto from "../../deno/src/crypto.ts";
import sqliteStorage from "../../deno/src/storage/sqlite.ts";
import denoWebsocketNotifer from "../../deno/src/websockets.ts";
import { Clock } from "../../shared/clock.ts";
import { DiplomaticHTTPServer } from "../../shared/http/server.ts";

const port = Number.parseInt(Deno.env.get("DIPLOMATIC_HOST_PORT"));
if (!port) {
  throw "Missing DIPLOMATIC_HOST_PORT env var";
}

const args = Deno.args;
const useHttps = args.includes("--https");

const server = new DiplomaticHTTPServer(
  sqliteStorage,
  libsodiumCrypto,
  denoWebsocketNotifer,
  new Clock(),
);

if (useHttps) {
  const cert = Deno.readTextFileSync("certs/localhost.pem");
  const key = Deno.readTextFileSync("certs/localhost-key.pem");
  console.log(`DIPLOMATIC PARCEL SERVICE ACTIVE on https://localhost:${port}`);
  Deno.serve({ port, cert, key }, server.corsHandler);
} else {
  console.log(`DIPLOMATIC PARCEL SERVICE ACTIVE on http://localhost:${port}`);
  Deno.serve({ port }, server.corsHandler);
}
