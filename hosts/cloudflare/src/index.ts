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

import type {
	IEnvelope,
	IHostCrypto,
	IMsgpackCodec,
	IStorage,
	IWebsocketNotifier,
	PublicKey,
} from "../../../shared/types";
import { DiplomaticServer } from "../../../shared/server";
import { decode, decodeAsync, encode } from "@msgpack/msgpack";
import { DurableObject } from "cloudflare:workers";
import { btoh, concat, htob } from "../../../shared/binary";

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

	async sha256Hash(data) {
		const buf = await crypto.subtle.digest("SHA-256", data);
		const arr = new Uint8Array(buf);
		return arr;
	},
};

const msgpack: IMsgpackCodec = {
	encode,
	decode,
	decodeAsync,
};

export class WebSocketServer extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get("Upgrade");
		if (upgradeHeader === "websocket") {
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
			statusText: "Bad Request",
			headers: {
				"Content-Type": "text/plain",
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
			async addUser(pubKey: Uint8Array) {
				const pubKeyHex = btoh(pubKey);
				await env.DIP_DB.prepare(
					"INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING",
				).bind(pubKeyHex).run();
			},

			async hasUser(pubKey: Uint8Array) {
				const pubKeyHex = btoh(pubKey);
				const has = await env.DIP_DB.prepare(
					"SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?)",
				).bind(pubKeyHex).first<boolean>();
				return has ?? false;
			},

			async setEnvelope(
				pubKey: Uint8Array,
				recordedAt: Date,
				env: IEnvelope,
				sha256: Uint8Array,
			) {
				const pubKeyHex = btoh(pubKey);
				const recAtStr = recordedAt.toISOString();
				const headCph = concat(concat(env.sig, env.kdm), env.headCph);
				const bodyCph = env.bodyCph;
				await env.DIP_DB.prepare(
					"INSERT INTO bag (sha256, userPubKey, recordedAt, headCph, bodyCph) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
				)
					.bind(sha256, pubKeyHex, recAtStr, headCph, bodyCph)
					.run();
			},

			async getBody(pubKey: Uint8Array, sha256: Uint8Array) {
				const pubKeyHex = btoh(pubKey);
				const row = await env.DIP_DB.prepare(
					"SELECT bodyCph FROM bag WHERE userPubKey = ? AND sha256 = ?",
				)
					.bind(pubKeyHex, sha256)
					.first<{ bodyCph: Uint8Array }>();
				if (!row) {
					return undefined;
				}
				return new Uint8Array(row.bodyCph);
			},

			async listHeads(pubKey: Uint8Array, begin: string, end: string) {
				const pubKeyHex = btoh(pubKey);
				const rows = await env.DIP_DB.prepare(
					"SELECT sha256, recordedAt, headCph FROM bag WHERE userPubKey = ? AND recordedAt >= ? AND recordedAt < ?",
				)
					.bind(pubKeyHex, begin, end)
					.all<
						{ sha256: Uint8Array; recordedAt: string; headCph: Uint8Array }
					>();
				return rows.results?.map((row) => ({
					sha256: row.sha256,
					recordedAt: new Date(row.recordedAt),
					headCph: new Uint8Array(row.headCph),
				}));
			},
		};

		const notifier: IWebsocketNotifier = {
			handler: async (request, hasUser) => {
				const url = new URL(request.url);
				const pubKeyHex = url.searchParams.get("key");
				if (!pubKeyHex) {
					return new Response("Missing pubkey", { status: 401 });
				}
				const pubKey = htob(pubKeyHex) as PublicKey;
				if (!(await hasUser(pubKey))) {
					return new Response("Unauthorized", { status: 401 });
				}
				const id = env.WEBSOCKET_SERVER.idFromName(pubKeyHex);
				const stub = env.WEBSOCKET_SERVER.get(id);
				const resp = await stub.fetch(request);
				return resp;
			},
			notify: async (pubKey) => {
				const pubKeyHex = btoh(pubKey);
				const id = env.WEBSOCKET_SERVER.idFromName(pubKeyHex);
				const stub = env.WEBSOCKET_SERVER.get(id);
				const request = new Request("http://durableobject/notify", {
					method: "POST",
				});
				await stub.fetch(request);
			},
		};

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
