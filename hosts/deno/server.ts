import libsodiumCrypto from "../../deno/src/crypto.ts";
import sqliteStorage from "../../deno/src/storage/sqlite.ts";
import denoWebsocketNotifer from "../../deno/src/websockets.ts";
import { Clock } from "../../shared/clock.ts";
import { DiplomaticHTTPServer, validateWebSocketAuth } from "../../shared/http/server.ts";
import { Status } from "../../shared/consts.ts";
import type { IPushOpenResponse } from "../../shared/types.ts";

const portStr = Deno.env.get("DIPLOMATIC_HOST_PORT");
if (!portStr) {
  throw "Missing DIPLOMATIC_HOST_PORT env var";
}
const port = Number.parseInt(portStr);
if (!port) {
  throw "Invalid DIPLOMATIC_HOST_PORT env var";
}

const args = Deno.args;
const useHttps = args.includes("--https");

const server = new DiplomaticHTTPServer(
  sqliteStorage,
  libsodiumCrypto,
  denoWebsocketNotifer,
  new Clock(),
);

const fetchHandler = async (request: Request): Promise<Response> => {
  if (request.headers.get("upgrade") === "websocket") {
    const [authTS, authStatus] = await validateWebSocketAuth(request, server);
    if (authStatus !== Status.Success) {
      return new Response("Unauthorized", { status: 401 });
    }
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onopen = () => {
      denoWebsocketNotifer.open(authTS, (data) => socket.send(data), server.crypto, server.clock).then(channel => {
        if (channel.status !== Status.Success) {
          socket.close();
          return;
        }
        // TODO: fix this as any. I don't like this sticking the channel on the socket.
        // Can we just keep a variable in the fetchHandler closure instead?
        (socket as any).channel = channel;
      });
    };
    socket.onclose = () => {
      ((socket as any).channel as IPushOpenResponse)?.shut();
    };
    return response;
  }
  return server.corsHandler(request);
};

if (useHttps) {
  const cert = Deno.readTextFileSync("certs/localhost.pem");
  const key = Deno.readTextFileSync("certs/localhost-key.pem");
  console.log(`DIPLOMATIC PARCEL SERVICE ACTIVE on https://localhost:${port}`);
  Deno.serve({ port, cert, key }, fetchHandler);
} else {
  console.log(`DIPLOMATIC PARCEL SERVICE ACTIVE on http://localhost:${port}`);
  Deno.serve({ port }, fetchHandler);
}
