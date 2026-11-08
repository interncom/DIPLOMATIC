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
import { connIDSkip, nextConnID } from "../../../shared/connID.ts";
import { Clock } from "../../../shared/clock.ts";
import { encodeStruct } from "../../../shared/codec.ts";
import { connIDFrameCodec } from "../../../shared/codecs/connID.ts";
import { notifMsgCodec } from "../../../shared/codecs/notifMsg.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";
import {
  isBodyKey,
  maxInlineBodyBytes,
  newBodyKey,
} from "../../../shared/bodykey.ts";
import {
  hashBytes,
  initConnID,
  NotifType,
  Status,
} from "../../../shared/consts.ts";
import {
  DiplomaticHTTPServer,
  validateWebSocketAuth,
} from "../../../shared/http/server";
import type {
  IHostCrypto,
  IPushNotifier,
  ISetBagResult,
  IStorage,
} from "../../../shared/types";
import { nullSubMeta } from "../../../shared/types.ts";
import { err, ok, type ValStat } from "../../../shared/valstat.ts";

interface Env {
  DIP_DB: D1Database;
  DIP_BLOBS: R2Bucket;
  WEBSOCKET_SERVER: DurableObjectNamespace<WebSocketServerV2>;
}

// dropBlobs deletes R2 objects whose bag row did not commit.
async function dropBlobs(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await bucket.delete(key);
    } catch (e) {
      logStorageError("dropBlobs", e, { key });
    }
  }
}

// readBlob reads one off-row body.
// readBlob returns StorageError for a bad key or a missing object.
async function readBlob(
  bucket: R2Bucket,
  key: string,
): Promise<ValStat<Uint8Array>> {
  if (!isBodyKey(key)) return err(Status.StorageError);
  try {
    const obj = await bucket.get(key);
    if (!obj) return err(Status.StorageError);
    return ok(new Uint8Array(await obj.arrayBuffer()));
  } catch (e) {
    logStorageError("readBlob", e, { key });
    return err(Status.StorageError);
  }
}

function logStorageError(
  op: string,
  e: unknown,
  extra?: Record<string, unknown>,
) {
  const msg = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error ? e.stack : undefined;
  console.error(`[D1] ${op} failed:`, msg, extra ?? {}, stack ?? "");
}

const cloudflareCrypto: IHostCrypto = {
  // importVerifyKey imports an Ed25519 verify key for reuse across a batch of checks.
  async importVerifyKey(pubKey) {
    return await crypto.subtle.importKey(
      "raw",
      pubKey,
      "ED25519",
      true,
      ["verify"],
    );
  },
  async checkSigEd25519(sig, message, verifyKey) {
    if (typeof message === "string") {
      const encoder = new TextEncoder();
      const encMsg = encoder.encode(message);
      return await crypto.subtle.verify("ED25519", verifyKey, sig, encMsg);
    }
    return await crypto.subtle.verify("ED25519", verifyKey, sig, message);
  },
};

// notifyConnParam names the connID query on the worker-to-DO notify hop.
const notifyConnParam = "c";

// socketConnID reads the connection id stored on a hibernating socket.
function socketConnID(socket: WebSocket): number {
  const att: unknown = socket.deserializeAttachment();
  if (typeof att !== "number" || !Number.isSafeInteger(att) || att < 1) {
    return initConnID;
  }
  return att;
}

// notifyConnID reads the connID to skip. Missing or dirty input skips nobody.
function notifyConnID(url: URL): number {
  const raw = url.searchParams.get(notifyConnParam);
  if (raw === null || raw.length === 0) return initConnID;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return initConnID;
  return n;
}

// sendBytes writes a fresh buffer. A view's .buffer can be larger than the view.
function sendBytes(socket: WebSocket, bytes: Uint8Array): void {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  socket.send(buf);
}

export class WebSocketServerV2 extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader === "websocket") {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      const [connID, idSt] = nextConnID(
        this.ctx.getWebSockets().map((s) => socketConnID(s)),
      );
      if (idSt !== Status.Success) {
        return new Response(null, { status: 503 });
      }
      const [frame, fst] = encodeStruct(connIDFrameCodec, connID);
      if (fst !== Status.Success) {
        return new Response(null, { status: 503 });
      }
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(connID);
      sendBytes(server, frame);
      console.log("[DO] WS upgrade accepted");

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    const url = new URL(request.url);
    if (url.pathname.endsWith("/notify")) {
      const body = new Uint8Array(await request.arrayBuffer());
      const [frame, fst] = encodeStruct(notifMsgCodec, {
        typ: NotifType.Notif,
        body,
      });
      if (fst !== Status.Success) {
        return new Response(null, { status: 400 });
      }
      const pushConnID = notifyConnID(url);
      const sockets = this.ctx.getWebSockets();
      console.log(`[DO] /notify received, sockets: ${sockets.length}`);
      for (const socket of sockets) {
        const skip = connIDSkip(socketConnID(socket), pushConnID);
        if (skip) continue;
        sendBytes(socket, frame);
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
  // The durable object assigns the connID on upgrade and sends it.
  // This stub does not track sockets.
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

  push: async (pubKey, data, connID) => {
    const pubKeyHex = btoh(pubKey);
    const id = env.WEBSOCKET_SERVER.idFromName(pubKeyHex);
    const stub = env.WEBSOCKET_SERVER.get(id);
    const url = new URL("http://durableobject/notify");
    if (connID !== undefined && connID > initConnID) {
      url.searchParams.set(notifyConnParam, String(connID));
    }
    const request = new Request(url, {
      method: "POST",
      body: data,
    });
    try {
      const t0 = Date.now();
      const resp = await stub.fetch(request);
      console.info(
        `[DO] notify done status=${resp.status} bytes=${data.length} ms=${
          Date.now() - t0
        }`,
      );
    } catch (e) {
      // Bags are already stored. A missed notify does not fail the push.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[DO] notify failed:`, msg, { bytes: data.length });
    }
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
        } catch (e) {
          logStorageError("addUser", e);
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
        } catch (e) {
          logStorageError("hasUser", e);
          return err(Status.StorageError);
        }
      },

      async subMeta(_pubKey) {
        return ok(nullSubMeta);
      },

      // setBags assigns seq via MAX+1 inside each INSERT so concurrent writers
      // cannot both claim the same seq. D1 batch() = one SQL transaction per
      // chunk (statements run sequentially; each sees prior inserts in the txn).
      // An oversized body is put in R2 before its row. A failed put returns
      // StorageError for that bag and skips the row. A failed batch deletes
      // objects whose rows did not commit and fails the call.
      async setBags(pubKey, bags) {
        if (bags.length < 1) return ok([]);
        const validBagIndexes: number[] = [];
        for (let i = 0; i < bags.length; i++) {
          if (bags[i].rlm.byteLength === hashBytes) validBagIndexes.push(i);
        }
        if (validBagIndexes.length < 1) {
          return ok(bags.map(() => ({ status: Status.InvalidParam })));
        }
        const t0 = Date.now();
        const blobErr = new Set<number>();
        // slots are the bags that will get a row: input index, and R2 key or null if inline.
        const slots: { i: number; key: string | null }[] = [];
        const seqByIdx = new Map<number, number>();
        // numCommittedStmts counts insert statements whose batch() has returned.
        // numCommittedStmts indexes slots. It is not a byte count.
        let numCommittedStmts = 0;
        try {
          const pubKeyHex = btoh(pubKey);
          // seq is allocated per rlm, relative to current rows (and prior
          // inserts in the same batch transaction).
          const insertSql = `
            INSERT INTO bags (userPubKey, rlm, seq, headCph, bodyCph, bodyKey)
            VALUES (
              ?,
              ?,
              (SELECT COALESCE(MAX(seq), 0) + 1 FROM bags
                WHERE userPubKey = ? AND rlm = ?),
              ?,
              ?,
              ?
            )
            RETURNING seq`;

          const stmts: D1PreparedStatement[] = [];
          // numBodyBytes sums bodyCph bytes of valid-rlm bags, including a put that fails.
          let numBodyBytes = 0;
          // numExternal counts off-row bodies written to R2. A failed put is not counted.
          let numExternal = 0;
          // puts are the R2 uploads for oversized bodies. They run together.
          // puts skip a failed upload: that bag gets no row and no seq.
          const puts: Promise<{ i: number; key: string; ok: boolean }>[] = [];
          for (const i of validBagIndexes) {
            const bag = bags[i];
            numBodyBytes += bag.bodyCph.byteLength;
            if (bag.bodyCph.byteLength <= maxInlineBodyBytes) continue;
            const key = newBodyKey(pubKeyHex, bag.rlm);
            const bodyCph = bag.bodyCph;
            puts.push(
              env.DIP_BLOBS.put(key, bodyCph).then(
                () => ({ i, key, ok: true }),
                async (e: unknown) => {
                  logStorageError("putBlob", e, { key });
                  try {
                    await dropBlobs(env.DIP_BLOBS, [key]);
                  } catch (dropErr) {
                    logStorageError("dropBlobs", dropErr, { key });
                  }
                  return { i, key, ok: false };
                },
              ),
            );
          }
          const putByIdx = new Map<number, { key: string; ok: boolean }>();
          for (const put of await Promise.all(puts)) putByIdx.set(put.i, put);
          for (const i of validBagIndexes) {
            const bag = bags[i];
            let body: Uint8Array | null = bag.bodyCph;
            let key: string | null = null;
            const put = putByIdx.get(i);
            if (put) {
              if (!put.ok) {
                blobErr.add(i);
                continue;
              }
              body = null;
              key = put.key;
            }
            const [headCph, hst] = encodeStruct(peekItemHeadCodec, bag);
            if (hst !== Status.Success) {
              if (key !== null) await dropBlobs(env.DIP_BLOBS, [key]);
              blobErr.add(i);
              continue;
            }
            if (key !== null) numExternal += 1;
            slots.push({ i, key });
            stmts.push(
              env.DIP_DB.prepare(insertSql).bind(
                pubKeyHex,
                bag.rlm,
                pubKeyHex,
                bag.rlm,
                headCph,
                body,
                key,
              ),
            );
          }

          // D1 max ~1000 statements per batch; each batch is one transaction.
          if (stmts.length > 0) {
            const chunkSize = 500;
            let n = 0;
            let badSeq = false;
            for (let i = 0; i < stmts.length; i += chunkSize) {
              const batchStmts = stmts.slice(i, i + chunkSize);
              const results = await env.DIP_DB.batch<{ seq: number }>(
                batchStmts,
              );
              numCommittedStmts = i + batchStmts.length;
              for (const r of results) {
                const row = r.results?.[0];
                const slot = slots[n];
                n += 1;
                if (!slot || !row || typeof row.seq !== "number") {
                  badSeq = true;
                  break;
                }
                seqByIdx.set(slot.i, row.seq);
              }
              if (badSeq) break;
            }
            // This chunk committed. Delete only objects from later chunks.
            if (badSeq || n !== slots.length) {
              const keys: string[] = [];
              for (let i = numCommittedStmts; i < slots.length; i++) {
                const key = slots[i].key;
                if (key) keys.push(key);
              }
              await dropBlobs(env.DIP_BLOBS, keys);
              logStorageError("setBags", "missing seq", {
                n: bags.length,
                ms: Date.now() - t0,
              });
              return err(Status.StorageError);
            }
          }

          console.info(
            `[D1] setBags n=${bags.length} numBodyBytes=${numBodyBytes} numExternal=${numExternal} ms=${
              Date.now() - t0
            }`,
          );
          // One result per input bag, in the caller's order.
          const out: ISetBagResult[] = [];
          for (let i = 0; i < bags.length; i++) {
            if (bags[i].rlm.byteLength !== hashBytes) {
              out.push({ status: Status.InvalidParam });
              continue;
            }
            if (blobErr.has(i)) {
              out.push({ status: Status.StorageError });
              continue;
            }
            const seq = seqByIdx.get(i);
            if (seq === undefined) return err(Status.StorageError);
            out.push({ status: Status.Success, seq });
          }
          return ok(out);
        } catch (e) {
          // D1 threw. Delete objects whose rows did not commit.
          const keys: string[] = [];
          for (let i = numCommittedStmts; i < slots.length; i++) {
            const key = slots[i].key;
            if (key) keys.push(key);
          }
          try {
            await dropBlobs(env.DIP_BLOBS, keys);
          } catch (dropErr) {
            logStorageError("dropBlobs", dropErr, { n: keys.length });
          }
          logStorageError("setBags", e, {
            n: bags.length,
            ms: Date.now() - t0,
          });
          return err(Status.StorageError);
        }
      },

      async getBodies(pubKey, rlm, seqs) {
        if (rlm.byteLength !== hashBytes) return err(Status.InvalidParam);
        if (seqs.length < 1) return ok([]);
        const t0 = Date.now();
        // reads is one R2 read per off-row body. The reads run together for this call.
        const reads: Promise<{ seq: number; res: ValStat<Uint8Array> }>[] = [];
        try {
          const pubKeyHex = btoh(pubKey);
          const out: { seq: number; bodyCph: Uint8Array }[] = [];
          // SQLite/D1 reject queries with too many bound parameters
          // ("too many SQL variables"). D1's limit is ~100; leave slots for
          // userPubKey and rlm so each IN stays at maxBinds-2 seq placeholders.
          const maxBinds = 100;
          const chunk = maxBinds - 2;
          for (let i = 0; i < seqs.length; i += chunk) {
            const part = seqs.slice(i, i + chunk);
            const placeholders = part.map(() => "?").join(",");
            const rows = await env.DIP_DB.prepare(
              `SELECT seq, bodyCph, bodyKey FROM bags WHERE userPubKey = ? AND rlm = ? AND seq IN (${placeholders})`,
            )
              .bind(pubKeyHex, rlm, ...part)
              .all<{
                seq: number;
                bodyCph: ArrayBuffer | null;
                bodyKey: string | null;
              }>();
            for (const row of rows.results ?? []) {
              if (typeof row.bodyKey === "string") {
                const seq = row.seq;
                const key = row.bodyKey;
                reads.push(
                  readBlob(env.DIP_BLOBS, key).then((res) => ({ seq, res })),
                );
                continue;
              }
              if (row.bodyCph) {
                out.push({
                  seq: row.seq,
                  bodyCph: new Uint8Array(row.bodyCph),
                });
              }
            }
          }
          // One failed read fails the call.
          const ext = await Promise.all(reads);
          for (const body of ext) {
            const [bodyCph, st] = body.res;
            if (st !== Status.Success) return err(st);
            out.push({ seq: body.seq, bodyCph });
          }
          console.info(
            `[D1] getBodies n=${seqs.length} found=${out.length} ms=${
              Date.now() - t0
            }`,
          );
          return ok(out);
        } catch (e) {
          // D1 threw. Drain in-flight reads so they do not reject unhandled.
          await Promise.allSettled(reads);
          logStorageError("getBodies", e, { n: seqs.length });
          return err(Status.StorageError);
        }
      },

      async listHeads(pubKey, rlm, minSeq) {
        if (rlm.byteLength !== hashBytes) return err(Status.InvalidParam);
        try {
          const pubKeyHex = btoh(pubKey);
          const rows = await env.DIP_DB.prepare(
            "SELECT seq, headCph FROM bags WHERE userPubKey = ? AND rlm = ? AND seq > ? ORDER BY seq",
          )
            .bind(pubKeyHex, rlm, minSeq)
            .all<{ seq: number; headCph: Uint8Array }>();
          return ok(
            rows.results?.map((row) => ({
              seq: row.seq,
              headCph: new Uint8Array(row.headCph),
            })) || [],
          );
        } catch (e) {
          logStorageError("listHeads", e, { minSeq });
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
