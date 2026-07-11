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

/// <reference types="./env.d.ts" />

import { DurableObject } from "cloudflare:workers";
import { validateAuthTimestamp } from "../../../shared/auth.ts";
import { btoh } from "../../../shared/binary.ts";
import { Clock } from "../../../shared/clock.ts";
import { Encoder } from "../../../shared/codec.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";
import { Status } from "../../../shared/consts.ts";
import {
  DiplomaticHTTPServer,
  validateWebSocketAuth,
} from "../../../shared/http/server";
import type {
  IHostCrypto,
  IPushNotifier,
  IStorage,
} from "../../../shared/types";
import { nullSubMeta } from "../../../shared/types.ts";
import { err, ok } from "../../../shared/valstat.ts";

interface Env {
  DIP_DB: D1Database;
  WEBSOCKET_SERVER: DurableObjectNamespace<WebSocketServerV2>;
}

const cloudflareCrypto: IHostCrypto = {
  async checkSigEd25519(sig, message, pubKey) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      pubKey,
      "ED25519",
      true,
      ["verify"],
    );
    if (typeof message === "string") {
      const encoder = new TextEncoder();
      const encMsg = encoder.encode(message);
      return await crypto.subtle.verify("ED25519", cryptoKey, sig, encMsg);
    }
    return await crypto.subtle.verify("ED25519", cryptoKey, sig, message);
  },
};

export class WebSocketServerV2 extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      this.ctx.acceptWebSocket(server);
      console.log("[DO] WS upgrade accepted");

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    if (request.url.endsWith("/notify")) {
      const body = await request.arrayBuffer();
      const data = new Uint8Array(body);
      const sockets = this.ctx.getWebSockets();
      console.log(`[DO] /notify received, sockets: ${sockets.length}`);
      for (const socket of sockets) {
        socket.send(data.buffer as ArrayBuffer);
      }
      return new Response(null, { status: 200 });
    }

    return new Response(null, {
      status: 400,
      statusText: "Bad Request",
      headers: {
        "Content-Type": "text/plain",
      },
    });
  }
}

const createCloudflareWebsocketNotifier = (
  env: Env,
): IPushNotifier => ({
  open: async (authTS, _recv, crypto, clock) => {
    const status = await validateAuthTimestamp(authTS, crypto, clock);
    if (status !== Status.Success) {
      return { send: () => status, shut: () => status, status };
    }
    return {
      send: () => Status.Success,
      shut: () => Status.Success,
      status: Status.Success,
    };
  },

  push: async (pubKey, data) => {
    const pubKeyHex = btoh(pubKey);
    const id = env.WEBSOCKET_SERVER.idFromName(pubKeyHex);
    const stub = env.WEBSOCKET_SERVER.get(id);
    const request = new Request("http://durableobject/notify", {
      method: "POST",
      body: data,
    });
    await stub.fetch(request);
  },
});

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const d1Storage: IStorage = {
      async addUser(pubKey) {
        try {
          const pubKeyHex = btoh(pubKey);
          await env.DIP_DB.prepare(
            "INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING",
          ).bind(pubKeyHex).run();
          return ok(undefined);
        } catch {
          return err(Status.StorageError);
        }
      },

      async hasUser(pubKey) {
        try {
          const pubKeyHex = btoh(pubKey);
          const has = await env.DIP_DB.prepare(
            "SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?)",
          ).bind(pubKeyHex).first<boolean>();
          return ok(has ?? false);
        } catch {
          return err(Status.StorageError);
        }
      },

      async subMeta(_pubKey) {
        return ok(nullSubMeta);
      },

      async setBag(pubKey, bag) {
        try {
          const pubKeyHex = btoh(pubKey);
          const row = await env.DIP_DB.prepare(
            "SELECT MAX(seq) FROM bags WHERE userPubKey = ?",
          )
            .bind(pubKeyHex).first<{ "MAX(seq)": number }>();
          const maxSeq = row ? row["MAX(seq)"] || 0 : 0;
          const seq = maxSeq + 1;
          const enc = new Encoder();
          enc.writeStruct(peekItemHeadCodec, bag);
          const headCph = enc.result();
          const bodyCph = bag.bodyCph;
          await env.DIP_DB.prepare(
            "INSERT INTO bags (userPubKey, seq, headCph, bodyCph) VALUES (?, ?, ?, ?)",
          )
            .bind(pubKeyHex, seq, headCph, bodyCph)
            .run();
          return ok(seq);
        } catch {
          return err(Status.StorageError);
        }
      },

      async getBody(pubKey, seq) {
        try {
          const pubKeyHex = btoh(pubKey);
          const row = await env.DIP_DB.prepare(
            "SELECT bodyCph FROM bags WHERE userPubKey = ? AND seq = ?",
          )
            .bind(pubKeyHex, seq)
            .first<{ bodyCph: Uint8Array }>();
          if (!row) {
            return ok(undefined);
          }
          return ok(new Uint8Array(row.bodyCph));
        } catch {
          return err(Status.StorageError);
        }
      },

      async listHeads(pubKey, minSeq) {
        try {
          const pubKeyHex = btoh(pubKey);
          const rows = await env.DIP_DB.prepare(
            "SELECT seq, headCph FROM bags WHERE userPubKey = ? AND seq > ? ORDER BY seq",
          )
            .bind(pubKeyHex, minSeq)
            .all<{ seq: number; headCph: Uint8Array }>();
          return ok(
            rows.results?.map((row) => ({
              seq: row.seq,
              headCph: new Uint8Array(row.headCph),
            })) || [],
          );
        } catch {
          return err(Status.StorageError);
        }
      },
    };

    const notifier: IPushNotifier = createCloudflareWebsocketNotifier(env);

    const server = new DiplomaticHTTPServer(
      d1Storage,
      cloudflareCrypto,
      notifier,
      new Clock(),
    );

    if (request.headers.get("Upgrade") === "websocket") {
      const [authTS, authStatus] = await validateWebSocketAuth(request, server);
      if (authStatus !== Status.Success) {
        return new Response("Unauthorized", { status: 401 });
      }
      const [hasUser, hasStatus] = await server.storage.hasUser(authTS.pubKey);
      if (hasStatus !== Status.Success || !hasUser) {
        return new Response("Unauthorized", { status: 401 });
      }
      const pubKeyHex = btoh(authTS.pubKey);
      const id = env.WEBSOCKET_SERVER.idFromName(pubKeyHex);
      const stub = env.WEBSOCKET_SERVER.get(id);
      return await stub.fetch(request);
    }

    return server.corsHandler(request);
  },
} satisfies ExportedHandler<Env>;
