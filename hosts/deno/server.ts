import { DiplomaticServer } from "../../shared/server.ts";
import memStorage from "../../deno/src/storage/memory.ts";
import denoMsgpack from "../../deno/src/codec.ts";
import libsodiumCrypto from "../../deno/src/crypto.ts";
import denoWebsocketNotifer from "../../deno/src/websockets.ts";

const hostID = Deno.env.get("DIPLOMATIC_HOST_ID");
const port = Number.parseInt(Deno.env.get("DIPLOMATIC_HOST_PORT"));
const regToken = Deno.env.get("DIPLOMATIC_REG_TOKEN");
if (!hostID) {
  throw "Missing DIPLOMATIC_HOST_ID env var"
}
if (!port) {
  throw "Missing DIPLOMATIC_HOST_PORT env var"
}
if (!regToken) {
  throw "Missing DIPLOMATIC_REG_TOKEN env var"
}

const args = Deno.args;
const useHttps = args.includes("--https");

const server = new DiplomaticServer(
  hostID,
  regToken,
  memStorage,
  denoMsgpack,
  libsodiumCrypto,
  denoWebsocketNotifer,
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
