import libsodiumCrypto from "../../bun/src/crypto.ts";
import sqliteStorage from "../../bun/src/storage/sqlite.ts";
import { Clock } from "../../shared/clock.ts";
import { DiplomaticHTTPServer } from "../../shared/http/server.ts";
import { validateAuthTimestamp } from "../../shared/auth.ts";
import { notifierTSAuthURLParam, Status } from "../../shared/consts.ts";
import { btoh, htob } from "../../shared/binary.ts";
import { authTimestampCodec, IAuthTimestamp } from "../../shared/codecs/authTimestamp.ts";
import { Decoder } from "../../shared/codec.ts";
import type { IHostCrypto, IWebSocketPushNotifier, IPushOpenResponse, PushReceiver, PublicKey } from "../../shared/types.ts";
import type { IClock } from "../../shared/clock.ts";

// Bun WebSocket notifier
class BunWebSocketNotifier implements IWebSocketPushNotifier {
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

  handle = async () => new Response("WebSockets handled by Bun", { status: 200 });
}

const bunNotifier = new BunWebSocketNotifier();

const port = Number.parseInt(process.env.DIPLOMATIC_HOST_PORT || "31337");

const server = new DiplomaticHTTPServer(
  sqliteStorage,
  libsodiumCrypto,
  bunNotifier,
  new Clock(),
);

console.log(`DIPLOMATIC PARCEL SERVICE ACTIVE on http://localhost:${port}`);
Bun.serve({
  port,
  fetch: server.corsHandler,
  websocket: {
    open(ws, req) {
      // Decode authTS from URL
      const url = new URL(req.url);
      const authTSHex = url.searchParams.get(notifierTSAuthURLParam);
      if (!authTSHex) {
        ws.close();
        return;
      }
      const authTSEnc = htob(authTSHex);
      const dec = new Decoder(authTSEnc);
      const [authTS, decStatus] = dec.readStruct(authTimestampCodec);
      if (decStatus !== Status.Success) {
        ws.close();
        return;
      }
      bunNotifier.open(authTS, (data) => ws.send(data), server.crypto, server.clock).then(channel => {
        if (channel.status !== Status.Success) {
          ws.close();
          return;
        }
        ws.addEventListener('close', () => channel.shut());
      });
    },
  },
});