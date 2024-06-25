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

import type { IHostCrypto, IMsgpackCodec } from "../../../shared/types";

const cloudflareCrypto: IHostCrypto = {
  async checkSigEd25519(sig, message, pubKey) {
    const cryptoKey = await crypto.subtle.importKey("raw", pubKey, "ED25519", true, ["verify"]);
    return await crypto.subtle.verify("ED25519", cryptoKey, sig, message);
  },
};

import { decodeAsync, encode, decode } from "@msgpack/msgpack";

const msgpack: IMsgpackCodec = {
  encode,
  decode,
  decodeAsync,
}

// TODO: impelement IStorage interface on D1 and R2.

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return new Response("Hi");
  },
} satisfies ExportedHandler<Env>;
