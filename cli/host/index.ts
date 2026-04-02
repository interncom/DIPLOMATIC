import libsodiumCrypto from "../../bun/src/crypto.ts";
import sqliteStorage from "../../bun/src/storage/sqlite.ts";
import { validateAuthTimestamp } from "../../shared/auth.ts";
import { btoh } from "../../shared/binary.ts";
import type { IClock } from "../../shared/clock.ts";
import { Clock } from "../../shared/clock.ts";
import { IAuthTimestamp } from "../../shared/codecs/authTimestamp.ts";
import { Status } from "../../shared/consts.ts";
import { DiplomaticHTTPServer, validateWebSocketAuth } from "../../shared/http/server.ts";
import type { IHostCrypto, IPushNotifier, IPushOpenResponse, PublicKey, PushReceiver } from "../../shared/types.ts";

// Bun WebSocket notifier
class BunWebSocketNotifier implements IPushNotifier {
  private recvs: Map<string, Set<PushReceiver>> = new Map();

  async open(authTS: IAuthTimestamp, recv: PushReceiver, crypto: IHostCrypto, clock: IClock): Promise<IPushOpenResponse> {
    const status = await validateAuthTimestamp(authTS, crypto, clock);
    if (status !== Status.Success) {
      return {
        send: () => status,
        shut: () => status,
        status,
      };
    }
    const pubKeyHex = btoh(authTS.pubKey);
    if (!this.recvs.has(pubKeyHex)) {
      this.recvs.set(pubKeyHex, new Set());
    }
    this.recvs.get(pubKeyHex)?.add(recv);
    return {
      send: (data) => { recv(data); return Status.Success; },
      shut: () => { this.recvs.get(pubKeyHex)?.delete(recv); return Status.Success; },
      status: Status.Success,
    };
  }

  async push(pubKey: PublicKey, data: Uint8Array): Promise<void> {
    const pubKeyHex = btoh(pubKey);
    const recvs = this.recvs.get(pubKeyHex);
    if (recvs) {
      for (const r of recvs) {
        r(data);
      }
    }
  }
}

const bunNotifier = new BunWebSocketNotifier();

export async function runBunHost(port: number = Number.parseInt(process.env.DIPLOMATIC_HOST_PORT || "31337")) {
  const server = new DiplomaticHTTPServer(
    sqliteStorage,
    libsodiumCrypto,
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
        return success ? undefined : new Response("Upgrade failed", { status: 400 });
      }
      return server.corsHandler(req);
    },
    websocket: {
      data: {} as { authTS: IAuthTimestamp },
      open: (ws) => {
        const authTS = ws.data.authTS;
        bunNotifier.open(authTS, (data) => ws.send(data), server.crypto, server.clock).then(channel => {
          if (channel.status !== Status.Success) {
            ws.close();
            return;
          }
          // TODO: fix this as any.
          (ws as any).channel = channel;
        });
      },
      message: (ws, msg) => { },
      close: (ws) => {
        ((ws as any).channel as IPushOpenResponse)?.shut();
      },
    },
  });
}
