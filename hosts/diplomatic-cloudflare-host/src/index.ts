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

import type { IHostCrypto, IMsgpackCodec, IStorage } from "../../../shared/types";
import { DiplomaticServer } from "../../../shared/server";
import { decodeAsync, encode, decode } from "@msgpack/msgpack";

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
};

const msgpack: IMsgpackCodec = {
  encode,
  decode,
  decodeAsync,
}

const hostID = "cfhost";
const regToken = "tok123";

interface Env {
  DIP_DB: D1Database;
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
        const rows = await env.DIP_DB.prepare("SELECT recordedAt FROM ops WHERE userPubKey = ? AND recordedAt >= ? AND recordedAt < ?").bind(pubKeyHex, begin, end).all<{ recordedAt: string }>();
        return rows.results?.map(row => row.recordedAt);
      },
    }

    const server = new DiplomaticServer(hostID, regToken, d1Storage, msgpack, cloudflareCrypto);

    return server.corsHandler(request);
  },
} satisfies ExportedHandler<Env>;
