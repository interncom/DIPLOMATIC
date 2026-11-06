// TODO: consolidate with src/host.ts. Same host, started on import.
import { Clock } from "../../shared/clock.ts";
import { IAuthTimestamp } from "../../shared/codecs/authTimestamp.ts";
import { Status } from "../../shared/consts.ts";
import {
  DiplomaticHTTPServer,
  validateWebSocketAuth,
} from "../../shared/http/server.ts";
import { CallbackNotifier } from "../../shared/lpc/pusher.ts";
import type { IPushOpenResponse } from "../../shared/types.ts";
import crypto from "./crypto.ts";
import sqliteStorage from "./storage/sqlite.ts";

const bunNotifier = new CallbackNotifier();

const port = Number.parseInt(process.env.DIPLOMATIC_HOST_PORT || "31337");

const server = new DiplomaticHTTPServer(
  sqliteStorage,
  crypto,
  bunNotifier,
  new Clock(),
);

console.log(`DIPLOMATIC PARCEL SERVICE ACTIVE on http://localhost:${port}`);
Bun.serve({
  port,
  fetch: async (req, bunServer) => {
    if (req.headers.get("upgrade") === "websocket") {
      const [authTS, authStatus] = await validateWebSocketAuth(req, server);
      if (authStatus !== Status.Success) {
        return new Response("Unauthorized", { status: 401 });
      }
      const success = bunServer.upgrade(req, { data: { authTS } });
      return success
        ? undefined
        : new Response("Upgrade failed", { status: 400 });
    }
    return server.corsHandler(req);
  },
  websocket: {
    data: {} as { authTS: IAuthTimestamp },
    open: (ws) => {
      const authTS = ws.data.authTS;
      bunNotifier.open(
        authTS,
        (data) => ws.send(data),
        server.crypto,
        server.clock,
      ).then((channel) => {
        if (channel.status !== Status.Success) {
          ws.close();
          return;
        }
        (ws as any).channel = channel;
      });
    },
    message: (ws, msg) => {},
    close: (ws) => {
      ((ws as any).channel as IPushOpenResponse)?.shut();
    },
  },
});
