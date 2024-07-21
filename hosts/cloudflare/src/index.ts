/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import type { IHostCrypto, IMsgpackCodec, IStorage, IWebsocketNotifier } from "../../../shared/types";
import { DiplomaticServer } from "../../../shared/server";
import { decodeAsync, encode, decode } from "@msgpack/msgpack";
import { DurableObject } from "cloudflare:workers";

const cloudflareCrypto: IHostCrypto = {
  async checkSigEd25519(sig, message, pubKey) {
    const cryptoKey = await crypto.subtle.importKey("raw", pubKey, "ED25519", true, ["verify"]);
    if (typeof message === "string") {
      const encoder = new TextEncoder();
      const encMsg = encoder.encode(message);
      return await crypto.subtle.verify("ED25519", cryptoKey, sig, encMsg);
    }
    return await crypto.subtle.verify("ED25519", cryptoKey, sig, message);
  },

  async sha256Hash(data) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    const arr = new Uint8Array(buf);
    return arr;
  },
};

const msgpack: IMsgpackCodec = {
  encode,
  decode,
  decodeAsync,
}

export class WebSocketServer extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      this.ctx.acceptWebSocket(server);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (request.url.endsWith("/notify")) {
      const sockets = this.ctx.getWebSockets();
      for (const socket of sockets) {
        socket.send("NEW OP");
      }
      return new Response(null, { status: 200 });
    }

    return new Response(null, {
      status: 400,
      statusText: 'Bad Request',
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }
}

const hostID = "cfhost";
const regToken = "tok123";

interface Env {
  DIP_DB: D1Database;
  WEBSOCKET_SERVER: DurableObjectNamespace<WebSocketServer>;
}
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const d1Storage: IStorage = {
      async addUser(pubKeyHex: string) {
        await env.DIP_DB.prepare("INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING").bind(pubKeyHex).run();
      },

      async hasUser(pubKeyHex: string) {
        const has = await env.DIP_DB.prepare("SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?)").bind(pubKeyHex).first<boolean>();
        return has ?? false;
      },

      async setOp(pubKeyHex: string, path: string, op: Uint8Array) {
        await env.DIP_DB.prepare("INSERT INTO ops (userPubKey, recordedAt, op, size) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(pubKeyHex, path, op, op.byteLength).run();
      },

      async getOp(pubKeyHex: string, path: string) {
        const row = await env.DIP_DB.prepare("SELECT op, size FROM ops WHERE userPubKey = ? AND recordedAt = ?").bind(pubKeyHex, path).first<{ op: Uint8Array, size: number }>();
        if (!row) {
          return undefined;
        }
        const op = new Uint8Array(row.op);
        return op.subarray(0, row.size);
      },

      async listOps(pubKeyHex: string, begin: string, end: string) {
        const rows = await env.DIP_DB.prepare("SELECT sha256 FROM ops WHERE userPubKey = ? AND recordedAt >= ? AND recordedAt < ?").bind(pubKeyHex, begin, end).all<{ sha256: string }>();
        return rows.results?.map(row => ({ sha256: row.sha256 }));
      },
    }

    const notifier: IWebsocketNotifier = {
      handler: async (request, hasUser) => {
        const url = new URL(request.url);
        const pubKeyHex = url.searchParams.get("key");
        if (!pubKeyHex) {
          return new Response("Missing pubkey", { status: 401 });
        }
        if (!await hasUser(pubKeyHex)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const id = env.WEBSOCKET_SERVER.idFromName(pubKeyHex);
        const stub = env.WEBSOCKET_SERVER.get(id);
        const resp = await stub.fetch(request);
        return resp;
      },
      notify: async (pubKeyHex) => {
        const id = env.WEBSOCKET_SERVER.idFromName(pubKeyHex);
        const stub = env.WEBSOCKET_SERVER.get(id);
        const request = new Request("http://durableobject/notify", { method: "POST" });
        await stub.fetch(request);
      },
    }

    const server = new DiplomaticServer(
      hostID,
      regToken,
      d1Storage,
      msgpack,
      cloudflareCrypto,
      notifier,
    );

    return server.corsHandler(request);
  },
} satisfies ExportedHandler<Env>;
