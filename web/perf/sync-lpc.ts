// Time LPC sync flows against the committed productivity dataset.
//
// Run from repo root (or web/):
//   bun run web/perf/sync-lpc.ts
//
// Client stores are SQLite (bun:sqlite) so enqueue/push/peek/pull/open pay real
// durable I/O (IDB-like). Host is in-memory LPC so host I/O is not the focus.
//
// Phases:
//   1) enqueue all msgs + upload (syncPush via LPC)
//   2) fresh client: peek all heads, then pull/open/exec (syncPeek + syncPull)
//
// Optional:
//   DATASET=path/to/msgs.msgpack
//   CLIENT_UP_DB=...    (uploader client archive)
//   CLIENT_DOWN_DB=...  (downloader client archive)

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import libsodiumCrypto from "../src/crypto";
import { entStateManager } from "../src/entdb/entdb";
import { EntDBMemory } from "../src/entdb/memory";
import DiplomaticClientAPI from "../src/shared/client";
import { MockClock } from "../src/shared/clock";
import { Encoder } from "../src/shared/codec";
import { messageHeadCodec } from "../src/shared/codecs/messageHead";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import { createMemoryStorage } from "../src/shared/storage/memory";
import type { Hash, IMessage, IProtoHost } from "../src/shared/types";
import { sortByHlcDesc } from "../src/hlc";
import { SqliteStore } from "./sqlite-store";
import { syncPeek, syncPull, syncPush } from "../src/sync";
import { APLD_APPLIED, APLD_PENDING } from "../src/types";
import type { IStore, IStoredMessageWrite } from "../src/types";
import {
  type ProdDatasetFile,
  recsToMessages,
  unpackDataset,
} from "./productivity";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDataset = join(here, "../../fixtures/productivity/msgs.msgpack");
const defaultClientUpDb = join(
  here,
  "../../fixtures/productivity/client-up-perf.db",
);
const defaultClientDownDb = join(
  here,
  "../../fixtures/productivity/client-down-perf.db",
);

const SEED_BYTES = new Uint8Array(32).fill(0x42);
function SEED(): Enclave {
  const [e, st] = Enclave.fromBytes(libsodiumCrypto, SEED_BYTES);
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclave ${st}`);
  }
  return e;
}
const HOST_LABEL = "lpc";
const HOST_IDX = 1;

function ms(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${n.toFixed(1)}ms`;
}

function rate(n: number, elapsedMs: number): string {
  const perS = n / (elapsedMs / 1000);
  return `${perS.toFixed(0)}/s`;
}

function loadDataset(path: string): ProdDatasetFile {
  const bytes = new Uint8Array(readFileSync(path));
  return unpackDataset(bytes);
}

async function hashMessage(
  msg: IMessage,
  crypto: typeof libsodiumCrypto,
): Promise<Hash> {
  const enc = new Encoder();
  const st = messageHeadCodec.encode(enc, msg);
  if (st !== Status.Success) throw new Error(`head encode ${st}`);
  return await crypto.blake3(enc.result()) as Hash;
}

/** Persist msgs + enqueue upload for HOST_LABEL (no apply/exec). */
async function enqueueAll(
  store: IStore<IProtoHost>,
  msgs: IMessage[],
  crypto: typeof libsodiumCrypto,
): Promise<number> {
  const batch: { key: Hash; data: IStoredMessageWrite }[] = [];
  const BATCH = 500;
  let n = 0;
  for (const msg of msgs) {
    const key = await hashMessage(msg, crypto);
    const data: IStoredMessageWrite = {
      eid: msg.eid,
      body: msg.bod,
      apld: APLD_APPLIED,
    };
    if (msg.off !== 0) data.off = msg.off;
    if (msg.ctr !== 0) data.ctr = msg.ctr;
    batch.push({ key, data });
    if (batch.length >= BATCH) {
      await store.messages.add(batch);
      await store.uploads.enq(HOST_LABEL, batch.map((b) => b.key));
      n += batch.length;
      batch.length = 0;
    }
  }
  if (batch.length > 0) {
    await store.messages.add(batch);
    await store.uploads.enq(HOST_LABEL, batch.map((b) => b.key));
    n += batch.length;
  }
  return n;
}

function wipeDbFiles(path: string) {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

async function main() {
  const datasetPath = process.env.DATASET ?? defaultDataset;
  const clientUpDb = process.env.CLIENT_UP_DB ?? defaultClientUpDb;
  const clientDownDb = process.env.CLIENT_DOWN_DB ?? defaultClientDownDb;
  console.log(`Loading ${datasetPath}`);
  const tLoad0 = performance.now();
  const file = loadDataset(datasetPath);
  const msgs = await recsToMessages(file.recs, libsodiumCrypto);
  const tLoad = performance.now() - tLoad0;
  console.log(
    `  ${msgs.length} msgs, ${file.ents} ents, load+hash ${ms(tLoad)}`,
  );

  // --- LPC host in-memory (host I/O not under optimization) ---
  wipeDbFiles(clientUpDb);
  wipeDbFiles(clientDownDb);
  console.log(`Host storage:   memory`);
  console.log(`Client up:      SQLite ${clientUpDb}`);
  console.log(`Client down:    SQLite ${clientDownDb}`);
  const storage = createMemoryStorage();
  const hostClock = new MockClock(new Date(0));
  const lpcHost = new DiplomaticLPCServer(
    storage,
    libsodiumCrypto,
    new CallbackNotifier(),
    hostClock,
  );
  const makeTransport = () => new LPCTransport(lpcHost);

  // --- uploader client (SQLite archive + queues) ---
  const upStore = new SqliteStore<IProtoHost>(clientUpDb, libsodiumCrypto);
  await upStore.seed.save(SEED(), { persist: true });
  await upStore.hosts.add({
    label: HOST_LABEL,
    handle: lpcHost,
    idx: HOST_IDX,
  });

  const enclave = await upStore.seed.load();
  if (!enclave) throw new Error("missing seed");

  const upHost = await upStore.hosts.get(HOST_LABEL);
  if (!upHost) throw new Error("missing host");

  const upConn = new DiplomaticClientAPI(
    enclave,
    libsodiumCrypto,
    upHost,
    hostClock,
    makeTransport(),
    () => Promise.resolve(Status.Success),
  );
  {
    const keys = await upConn.identity();
    const [, addSt] = await storage.addUser(keys.publicKey);
    if (addSt !== Status.Success) throw new Error(`addUser ${addSt}`);
  }

  // 1) enqueue
  console.log("\n=== 1. enqueue all messages ===");
  const tEnq0 = performance.now();
  const nEnq = await enqueueAll(upStore, msgs, libsodiumCrypto);
  const tEnq = performance.now() - tEnq0;
  const nUp = await upStore.uploads.count();
  console.log(
    `  enqueued ${nEnq} (queue=${nUp}) in ${ms(tEnq)} (${rate(nEnq, tEnq)})`,
  );

  // 2) push via LPC
  console.log("\n=== 2. upload (syncPush via LPC) ===");
  const tPush0 = performance.now();
  const pushStat = await syncPush({
    conn: upConn,
    store: upStore,
    enclave,
    host: upHost,
    crypto: libsodiumCrypto,
  });
  const tPush = performance.now() - tPush0;
  if (pushStat !== Status.Success) {
    throw new Error(`syncPush failed: ${Status[pushStat]} (${pushStat})`);
  }
  const left = await upStore.uploads.count();
  console.log(
    `  pushed ${nUp - left} bags in ${ms(tPush)} (${
      rate(nUp, tPush)
    }); queue left=${left}`,
  );

  const keys = await upConn.identity();
  const [heads, listSt] = await storage.listHeads(keys.publicKey, 0);
  if (listSt !== Status.Success) throw new Error(`listHeads ${listSt}`);
  console.log(`  host heads: ${heads.length}`);

  // --- downloader client (same seed, empty SQLite archive) ---
  console.log("\n=== 3. sync from host (peek → pull/open/exec) ===");
  const downStore = new SqliteStore<IProtoHost>(clientDownDb, libsodiumCrypto);
  await downStore.seed.save(SEED(), { persist: true });
  await downStore.hosts.add({
    label: HOST_LABEL,
    handle: lpcHost,
    idx: HOST_IDX,
  });
  const downEnclave = await downStore.seed.load();
  if (!downEnclave) throw new Error("missing seed");
  const downHostRow = await downStore.hosts.get(HOST_LABEL);
  if (!downHostRow) throw new Error("missing host");

  const downConn = new DiplomaticClientAPI(
    downEnclave,
    libsodiumCrypto,
    downHostRow,
    hostClock,
    makeTransport(),
    () => Promise.resolve(Status.Success),
  );

  // peek
  const tPeek0 = performance.now();
  const peekStat = await syncPeek({
    conn: downConn,
    store: downStore,
    enclave: downEnclave,
    host: downHostRow,
    crypto: libsodiumCrypto,
  });
  const tPeek = performance.now() - tPeek0;
  if (peekStat !== Status.Success) {
    throw new Error(`syncPeek failed: ${Status[peekStat]}`);
  }
  const nDl = await downStore.downloads.count();
  console.log(
    `  peek: ${nDl} downloads enqueued in ${ms(tPeek)} (${rate(nDl, tPeek)})`,
  );

  // pull + open + exec into EntDB
  const edb = new EntDBMemory();
  const state = entStateManager(edb);
  const refreshedHost = await downStore.hosts.get(HOST_LABEL);
  if (!refreshedHost) throw new Error("host gone");

  const tPull0 = performance.now();
  const pullStat = await syncPull(
    {
      conn: downConn,
      store: downStore,
      enclave: downEnclave,
      host: refreshedHost,
      crypto: libsodiumCrypto,
    },
    async () => {
      const pending = await downStore.messages.list({ apld: APLD_PENDING });
      if (pending.length < 1) return;
      // Match SyncClient: newest HLC first for early final app state.
      const ordered = sortByHlcDesc(pending, (m) => m.head);
      const toApply = ordered.map((m) => ({ ...m.head, bod: m.body }));
      const stats = await state.apply(toApply);
      const done: Hash[] = [];
      const failed: { key: Hash; err: Status }[] = [];
      for (let i = 0; i < ordered.length; i++) {
        const st = stats[i];
        if (st === Status.Success || st === Status.NoChange) {
          done.push(ordered[i].hash);
        } else if (
          st !== undefined &&
          st !== Status.DatabaseError &&
          st !== Status.StorageError
        ) {
          failed.push({ key: ordered[i].hash, err: st });
        }
      }
      if (done.length > 0) await downStore.messages.markApplied(done);
      if (failed.length > 0) await downStore.messages.markFailed(failed);
    },
  );
  const tPull = performance.now() - tPull0;
  if (pullStat !== Status.Success && pullStat !== Status.NoChange) {
    throw new Error(`syncPull failed: ${Status[pullStat]}`);
  }
  const archived = Array.from(await downStore.messages.list()).length;
  const [entCount, entSt] = await edb.countEntities({ type: "todo" });
  const ents = entSt === Status.Success && entCount !== undefined
    ? entCount
    : -1;

  console.log(
    `  pull+open+exec: ${archived} msgs archived, ${ents} ents in ${
      ms(tPull)
    } (${rate(nDl, tPull)})`,
  );
  console.log(`  downloads left: ${await downStore.downloads.count()}`);

  // --- summary ---
  console.log("\n=== summary ===");
  console.log(`  host store:     memory (LPC)`);
  console.log(`  client store:   SQLite (up + down DBs)`);
  console.log(`  dataset:        ${msgs.length} msgs / ${file.ents} ents`);
  console.log(`  load+hash:      ${ms(tLoad)}`);
  console.log(`  enqueue:        ${ms(tEnq)}  (${rate(msgs.length, tEnq)})`);
  console.log(`  push (LPC):     ${ms(tPush)}  (${rate(msgs.length, tPush)})`);
  console.log(`  peek (LPC):     ${ms(tPeek)}  (${rate(nDl, tPeek)})`);
  console.log(`  pull+open+exec: ${ms(tPull)}  (${rate(nDl, tPull)})`);
  console.log(`  total sync-ish: ${ms(tEnq + tPush + tPeek + tPull)}`);

  upStore.close();
  downStore.close();

  if (left !== 0) {
    console.error(`FAIL: upload queue not drained (${left})`);
    process.exit(1);
  }
  if (heads.length !== msgs.length) {
    console.error(`FAIL: host heads ${heads.length} != msgs ${msgs.length}`);
    process.exit(1);
  }
  if (nDl !== msgs.length) {
    console.error(`FAIL: downloads ${nDl} != msgs ${msgs.length}`);
    process.exit(1);
  }
  if (archived !== msgs.length) {
    console.error(`FAIL: archived ${archived} != msgs ${msgs.length}`);
    process.exit(1);
  }
  if (ents !== file.ents) {
    console.error(`FAIL: ents ${ents} != file.ents ${file.ents}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
