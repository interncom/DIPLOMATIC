// Sync: peek → push → pull‖open → exec.
//
// Inbound depth-1: kick next pull before open/exec of current (one Promise).
// Ciphertext stays in RAM only. Upload only after exec (client apply path).

import { batchByBytes } from "./batch";
import { sortByHlcDesc } from "./hlc";
import { mapPool } from "./mapPool";
import { openBagBody } from "./shared/bag";
import DiplomaticClientAPI from "./shared/client";
import { Decoder, Encoder } from "./shared/codec";
import type { IKDM } from "./shared/codecs/kdm";
import { IMessageHead, messageHeadCodec } from "./shared/codecs/messageHead";
import { notifItemCodec } from "./shared/codecs/notifItem";
import { Status } from "./shared/consts";
import { nullKDM } from "./shared/crypto/derivation";
import { Enclave } from "./shared/crypto/enclave";
import { decryptPeekItem } from "./shared/sync";
import {
  cursorOf,
  realmKDM,
  realmKDMs,
  realmKey,
  sameRealm,
  storedRealm,
} from "./stores/cursor";
import { realmLabel } from "./stores/realm";
import { Hash, HostHandle, IBag, ICrypto, IMessage } from "./shared/types";
import { err, ok, ValStat } from "./shared/valstat";
import { btob64 } from "./shared/binary";
import { checksumSet } from "./shared/checksum";
import {
  defaultPeekProgressEvery,
  ProgressFn,
  shouldEmitItemProgress,
} from "./progress";
import {
  APLD_PENDING,
  IDownloadMessage,
  IHostRow,
  IMsgParts,
  IStorableMessage,
  IStore,
  type IStoredMessageWrite,
  type ReconcileOpts,
  type ReconcileResult,
} from "./types";

/** Default soft cap for one push/pull request (~1 MiB). Apps with large
 * payloads (e.g. media) should raise maxPushBytes / maxPullBytes. */
export const defaultMaxPushBytes = 1 << 20;
export const defaultMaxPullBytes = 1 << 20;

/**
 * Concurrent peek-item crypto (sig verify + head open + head hash).
 * WebCrypto Ed25519 verifies pipeline better when overlapped.
 */
export const defaultPeekConcurrency = 64;

/** Pull result held in memory until open (not durable). */
export type IPulled = {
  dl: IDownloadMessage;
  bodyCph?: Uint8Array;
};

/** Host connection methods used by sync phases. */
export type SyncConn<Handle extends HostHandle> = Pick<
  DiplomaticClientAPI<Handle>,
  "pull" | "push" | "peek" | "seal" | "identity" | "hostRlm"
>;

export interface ISyncParams<Handle extends HostHandle> {
  conn: SyncConn<Handle>;
  store: IStore<Handle>;
  enclave: Enclave;
  host: IHostRow<Handle>;
  crypto: ICrypto;
  /** Soft max sealed-bag bytes per push request. Oversized bags go alone. */
  maxPushBytes?: number;
  /** Soft max body bytes (head.len) per pull request. Oversized items go alone. */
  maxPullBytes?: number;
  /** Optional progress sink (phases + item/batch ticks). */
  onProgress?: ProgressFn;
  /** Peek progress stride in heads (default `defaultPeekProgressEvery`). */
  peekProgressEvery?: number;
  /**
   * Max concurrent peek-item crypto ops (verify + head decrypt + blake3).
   * Default `defaultPeekConcurrency`. Set 1 for fully serial.
   */
  peekConcurrency?: number;
  /** Realm for this peek. Push and pull use each item's own realm. */
  realm?: IKDM;
}

/** Approximate on-wire bag size (sig + kdm + ciphers). Soft limit only. */
function bagBytes(bag: IBag): number {
  return bag.sig.length + bag.kdm.length + bag.headCph.length +
    bag.bodyCph.length;
}

type DeqGroup = { host: string; realm?: IKDM; seqs: number[] };

// Groups download seqs so one deq is one host and one realm.
function noteDeq(
  groups: Map<string, DeqGroup>,
  host: string,
  seq: number,
  realm?: IKDM,
) {
  const key = `${host}\0${realmKey(realm ?? nullKDM)}`;
  const g = groups.get(key);
  if (g) {
    g.seqs.push(seq);
    return;
  }
  groups.set(key, { host, realm, seqs: [seq] });
}

async function flushDeq<Handle extends HostHandle>(
  store: Pick<IStore<Handle>, "downloads">,
  groups: Map<string, DeqGroup>,
) {
  for (const g of groups.values()) {
    await store.downloads.deq(g.host, g.seqs, g.realm);
  }
}

/** Push one batch of sealed bags; deq successes; advance that realm's cursor. */
export async function pushBatch<Handle extends HostHandle>(
  conn: Pick<DiplomaticClientAPI<Handle>, "push">,
  store: IStore<Handle>,
  hostLabel: string,
  bags: IBag[],
  hashes: Hash[],
  realm: IKDM = nullKDM,
): Promise<Status> {
  if (bags.length < 1) {
    return Status.Success;
  }

  const [results, pushStatus] = await conn.push(bags);
  if (pushStatus !== Status.Success) {
    return pushStatus;
  }
  if (!results) {
    return Status.InvalidResponse;
  }

  for (const item of results) {
    if (item.status !== Status.Success) {
      // TODO: per-row push errors (retry-able vs not); track on upload queue.
      console.error("push err", item);
      continue;
    }
    const msgHeadEncHash = hashes[item.idx];
    if (!msgHeadEncHash) {
      console.error("no hash", item);
      continue;
    }
    // TODO: return batch status codes from deq too.
    await store.uploads.deq(hostLabel, [msgHeadEncHash]);
  }

  // lastSeq may have moved (peek / earlier pushes); only advance contiguous successes.
  const row = await store.hosts.get(hostLabel);
  if (row) {
    let currentMax = cursorOf(row, realm);
    const start = currentMax;
    const successfulSeqs: number[] = [];
    for (const item of results) {
      if (item.status === Status.Success) {
        successfulSeqs.push(item.seq);
      }
    }
    successfulSeqs.sort((a, b) => a - b);
    for (const seq of successfulSeqs) {
      if (seq === currentMax + 1) {
        currentMax = seq;
      }
    }
    if (currentMax > start) {
      await store.hosts.touch(hostLabel, currentMax, realm);
    }
  }

  return Status.Success;
}

/** pull: network only. Download-queue items → ciphertext (still enqueued). */
export async function pullBodies<Handle extends HostHandle>(
  conn: Pick<DiplomaticClientAPI<Handle>, "pull">,
  items: IDownloadMessage[],
): Promise<ValStat<IPulled[]>> {
  if (items.length < 1) {
    return ok([]);
  }

  type RealmPull = {
    realm: IKDM;
    dls: Map<number, IDownloadMessage>;
    seqs: number[];
  };
  const byRealm = new Map<string, RealmPull>();
  for (const item of items) {
    const realm = item.realm ?? nullKDM;
    const key = realmKey(realm);
    let pull = byRealm.get(key);
    if (!pull) {
      pull = { realm, dls: new Map(), seqs: [] };
      byRealm.set(key, pull);
    }
    pull.dls.set(item.seq, item);
    pull.seqs.push(item.seq);
  }

  const pulled: IPulled[] = [];
  for (const pull of byRealm.values()) {
    const [result, stat] = await conn.pull(pull.seqs, pull.realm);
    if (stat !== Status.Success) {
      // TODO: per-row pull errors (which seqs failed); track on download queue.
      return err(stat);
    }
    if (!result) {
      return err(Status.InvalidResponse);
    }
    for (const { seq, bodyCph } of result) {
      const dl = pull.dls.get(seq);
      if (!dl) continue;
      pulled.push({ dl, bodyCph });
    }
  }
  // TODO: seqs requested but missing from result — record per-row fetch failure.
  return ok(pulled);
}

export type IOpened = {
  parts: IMsgParts[];
  hashes: Hash[];
};

/**
 * open: decrypt pulled bodies → msg archive (apld=false), deq downloads.
 * Bad bags are dequeued and skipped (not retry-able).
 * Does not exec or push.
 */
export async function openPulled<Handle extends HostHandle>(
  store: IStore<Handle>,
  enclave: Enclave,
  crypto: ICrypto,
  items: IPulled[],
): Promise<ValStat<IOpened>> {
  if (items.length < 1) {
    return ok({ parts: [], hashes: [] });
  }

  const parts: IMsgParts[] = [];
  const hashes: Hash[] = [];
  const toStore: IStorableMessage[] = [];
  // Group seqs by host and realm so each downloads.deq is one store call.
  const deqGroups = new Map<string, DeqGroup>();

  for (const { dl, bodyCph } of items) {
    const { head, kdm, seq, host } = dl;
    const realm = dl.realm ?? nullKDM;
    // Prefer headEnc/hash from peek (avoids re-encode + double blake3).
    const [resolved, headStat] = await resolveHeadEnc(dl, crypto);
    if (headStat !== Status.Success) {
      noteDeq(deqGroups, host, seq, dl.realm);
      continue;
    }
    const { headEnc, headEncHash } = resolved;
    const cipher = enclave.deriveCipher(kdm, "decrypt", realm);
    const [contents, openStat] = await openBagBody(
      headEnc,
      bodyCph,
      cipher,
      crypto,
      headEncHash,
    );
    if (openStat !== Status.Success) {
      // Unopenable bag: drop from download queue (no retry). TODO: per-row open errors.
      noteDeq(deqGroups, host, seq, dl.realm);
      continue;
    }

    const p: IMsgParts = { head, body: contents.bod };
    const keyHash = contents.headHash;
    toStore.push({ key: keyHash, data: msg2StoredMsgData(p, realm) });
    parts.push(p);
    hashes.push(keyHash);
    noteDeq(deqGroups, host, seq, dl.realm);
  }

  const statsStore = await store.messages.add(toStore);
  // TODO: return batch status codes from deq too.
  await flushDeq(store, deqGroups);

  for (let i = 0; i < statsStore.length; i++) {
    const st = statsStore[i];
    if (st !== Status.Success && st !== Status.NoChange) {
      console.error("ERR storing", Status[st], "for message", i);
    }
  }

  return ok({ parts, hashes });
}

type PeekCryptoOk = {
  ok: true;
  seq: number;
  kdm: Uint8Array;
  headEnc: Uint8Array;
  headEncHash: Hash;
};
type PeekCryptoFail = { ok: false; seq: number; stat: Status };
type PeekCryptoResult = PeekCryptoOk | PeekCryptoFail;

/** headEnc + blake3 key for a download item (peek cache or re-encode). */
async function resolveHeadEnc(
  dl: IDownloadMessage,
  crypto: ICrypto,
): Promise<ValStat<{ headEnc: Uint8Array; headEncHash: Hash }>> {
  let headEnc = dl.headEnc;
  if (!headEnc) {
    const enc = new Encoder();
    const st = enc.writeStruct(messageHeadCodec, dl.head);
    if (st !== Status.Success) return err(st);
    headEnc = enc.result();
  }
  if (dl.headEncHash) {
    return ok({ headEnc, headEncHash: dl.headEncHash });
  }
  const headEncHash = await crypto.blake3(headEnc);
  return ok({ headEnc, headEncHash });
}

/**
 * Drop download-queue rows whose head matches archive keys we just stored
 * (import / local apply). One list() + batched deq — not per-row messages.has.
 */
export async function deqDownloadsForHeadHashes<Handle extends HostHandle>(
  store: Pick<IStore<Handle>, "downloads">,
  hashes: Iterable<Hash>,
  crypto: ICrypto,
): Promise<void> {
  const want = new Set<string>();
  for (const h of hashes) {
    want.add(btob64(h));
  }
  if (want.size < 1) return;

  const dls = Array.from(await store.downloads.list());
  if (dls.length < 1) return;

  const deqGroups = new Map<string, DeqGroup>();
  for (const d of dls) {
    let hashB64: string | undefined;
    if (d.headEncHash) {
      hashB64 = btob64(d.headEncHash);
    } else {
      const [resolved, st] = await resolveHeadEnc(d, crypto);
      if (st !== Status.Success) continue;
      hashB64 = btob64(resolved.headEncHash);
    }
    if (!want.has(hashB64)) continue;
    noteDeq(deqGroups, d.host, d.seq, d.realm);
  }
  await flushDeq(store, deqGroups);
}

/** Discover unseen bags and enqueue download work; advance host lastSeq. */
export async function syncPeek<Handle extends HostHandle>(
  {
    conn,
    store,
    enclave,
    host,
    crypto,
    onProgress,
    peekProgressEvery,
    peekConcurrency,
    realm: realmArg,
  }: ISyncParams<Handle>,
): Promise<Status> {
  const realm = realmArg ?? nullKDM;
  const [hostIdnt, ist] = await conn.identity();
  if (ist !== Status.Success) return ist;
  const [rlm, rst] = await conn.hostRlm(realm);
  if (rst !== Status.Success) return rst;
  let verifyKey: CryptoKey;
  try {
    verifyKey = await crypto.importVerifyKey(hostIdnt.publicKey);
  } catch {
    return Status.CryptoError;
  }
  const dls: IDownloadMessage[] = [];
  const [items, peekStatus] = await conn.peek(cursorOf(host, realm), realm);
  if (peekStatus !== Status.Success) {
    return peekStatus;
  }
  const total = items.length;
  const every = peekProgressEvery ?? defaultPeekProgressEvery;
  const conc = peekConcurrency ?? defaultPeekConcurrency;
  if (onProgress && total > 0) {
    onProgress({ phase: "peek", host: host.label, done: 0, total });
  }

  // Phase 1: concurrent crypto (Ed25519 verify + head decrypt + blake3).
  // Overlapping WebCrypto verifies is the main win vs serial await.
  let cryptoDone = 0;
  const cryptoResults = await mapPool(items, conc, async (item) => {
    const [itemDec, stat] = await decryptPeekItem(
      item,
      verifyKey,
      enclave,
      crypto,
      rlm,
      realm,
    );
    let result: PeekCryptoResult;
    if (stat !== Status.Success) {
      result = { ok: false, seq: item.seq, stat };
    } else {
      const headEncHash = await crypto.blake3(itemDec.headEnc);
      result = {
        ok: true,
        seq: item.seq,
        kdm: itemDec.kdm,
        headEnc: itemDec.headEnc,
        headEncHash,
      };
    }
    cryptoDone += 1;
    if (
      onProgress &&
      shouldEmitItemProgress(cryptoDone, total, every)
    ) {
      onProgress({
        phase: "peek",
        host: host.label,
        done: cryptoDone,
        total,
      });
    }
    return result;
  });

  // Phase 2: sequential store / enqueue (IDB-safe, stable ordering).
  // De-dupe downloads within this batch (same msg, multiple bags).
  const enqMsgs = new Set<string>();
  for (const result of cryptoResults) {
    if (!result.ok) {
      // Skip desyncs client vs host until CHECK reconciles message sets.
      console.error("peek: decrypting item head", result.stat);
      continue;
    }

    const msgKey = btob64(result.headEncHash);
    const msgExists = await store.messages.has(result.headEncHash);
    if (msgExists) {
      // Already archived (import or prior sync): no download. Drop any stale
      // download-queue row and redundant upload (host already has this msg).
      console.info("peek: local msg; skip download, deq upload");
      await store.uploads.deq(host.label, [result.headEncHash]);
      await store.downloads.deq(host.label, [result.seq], realm);
      continue;
    }

    // Already enqueueing a download for this msg from an earlier bag in batch.
    if (enqMsgs.has(msgKey)) {
      await store.downloads.deq(host.label, [result.seq], realm);
      continue;
    }

    const headDec = new Decoder(result.headEnc);
    const [head, headStatus] = headDec.readStruct(messageHeadCodec);
    if (headStatus !== Status.Success) {
      console.error("peek: reading item head", headStatus);
      continue;
    }

    enqMsgs.add(msgKey);
    const dl: IDownloadMessage = {
      kdm: result.kdm,
      head,
      seq: result.seq,
      host: host.label,
      headEnc: result.headEnc,
      headEncHash: result.headEncHash,
    };
    const tagged = storedRealm(realm);
    if (tagged !== undefined) dl.realm = tagged;
    dls.push(dl);
  }
  await store.downloads.enq(dls);

  // Advance cursor only (bag tallies are not tracked on the host row).
  if (items.length > 0) {
    const maxSeq = Math.max(...items.map((i) => i.seq));
    await store.hosts.recordSeqs(host.label, { lastSeq: maxSeq }, realm);
  }

  if (onProgress) {
    onProgress({
      phase: "peek",
      host: host.label,
      done: total,
      total,
    });
  }

  return Status.Success;
}

/** Seal and upload pending msgs; list once so concurrent enqs wait for next sync. */
export async function syncPush<Handle extends HostHandle>(
  { conn, store, host, maxPushBytes, onProgress }: ISyncParams<Handle>,
): Promise<Status> {
  const limit = maxPushBytes ?? defaultMaxPushBytes;
  const pending = await store.uploads.list(host.label);
  const total = pending.length;
  let done = 0;

  if (onProgress && total > 0) {
    onProgress({ phase: "push", host: host.label, done: 0, total });
  }

  let bags: IBag[] = [];
  let hashes: Hash[] = [];
  let batchBytes = 0;
  let batchRealm: IKDM = nullKDM;

  const flush = async (): Promise<Status> => {
    if (bags.length < 1) {
      return Status.Success;
    }
    const n = bags.length;
    const st = await pushBatch(
      conn,
      store,
      host.label,
      bags,
      hashes,
      batchRealm,
    );
    bags = [];
    hashes = [];
    batchBytes = 0;
    if (st === Status.Success) {
      done += n;
      if (onProgress) {
        onProgress({ phase: "push", host: host.label, done, total });
      }
    }
    return st;
  };

  // One batch is one realm, so its seqs share a cursor.
  type Ready = { hash: Hash; realm: IKDM; msg: IMessage };
  const ready: Ready[] = [];
  const realmRows = await store.realms.list();
  for (const msgHeadEncHash of pending) {
    const storedMsg = await store.messages.get(msgHeadEncHash);
    if (!storedMsg) {
      done += 1;
      continue;
    }
    ready.push({
      hash: msgHeadEncHash,
      realm: realmKDM(storedMsg.rlm, realmRows),
      msg: { ...storedMsg.head, bod: storedMsg.body },
    });
  }
  ready.sort((a, b) => {
    if (a.realm.label < b.realm.label) return -1;
    if (a.realm.label > b.realm.label) return 1;
    return a.realm.index - b.realm.index;
  });

  for (const item of ready) {
    if (bags.length > 0 && !sameRealm(batchRealm, item.realm)) {
      const st = await flush();
      if (st !== Status.Success) return st;
    }
    const [bag, statBag] = await conn.seal(item.msg, item.realm);
    if (statBag !== Status.Success) return statBag;
    const size = bagBytes(bag);
    if (bags.length > 0 && batchBytes + size > limit) {
      const st = await flush();
      if (st !== Status.Success) return st;
    }
    if (bags.length < 1) batchRealm = item.realm;
    bags.push(bag);
    hashes.push(item.hash);
    batchBytes += size;
    if (batchBytes >= limit) {
      const st = await flush();
      if (st !== Status.Success) return st;
    }
  }

  return flush();
}

/**
 * Pull + open for one host, depth-1 pipelined:
 *   await pull(i); start pull(i+1); open(i); afterOpen? (exec)
 * Ciphertext only in the in-flight Promise, never IDB.
 *
 * Download work is ordered newest→oldest by message HLC (not host seq).
 * All bags are still pulled/opened; EntDB LWW already ignores obsolete ops.
 * Newest-first exec reaches final app state early in a large catch-up.
 */
export async function syncPull<Handle extends HostHandle>(
  {
    conn,
    store,
    enclave,
    host,
    crypto,
    maxPullBytes,
    onProgress,
  }: ISyncParams<Handle>,
  /** After each opened pull batch (e.g. drainApplyQueue / exec). */
  afterOpen?: () => Promise<void>,
): Promise<Status> {
  const limit = maxPullBytes ?? defaultMaxPullBytes;
  const allItems = await store.downloads.list();
  const hostItems = Array.from(allItems).filter((i) => i.host === host.label);
  if (hostItems.length < 1) {
    return Status.NoChange;
  }

  // HLC order so early exec converges UI state.
  const items = sortByHlcDesc(hostItems, (d) => d.head);
  const batches = batchByBytes(items, (d) => d.head.len, limit);
  const total = items.length;
  let done = 0;
  if (onProgress) {
    onProgress({ phase: "pull", host: host.label, done: 0, total });
  }

  let nextPull = pullBodies(conn, batches[0]);

  for (let i = 0; i < batches.length; i++) {
    const [pulled, pullStat] = await nextPull;
    if (pullStat !== Status.Success) {
      return pullStat;
    }
    done += batches[i].length;
    if (onProgress) {
      onProgress({ phase: "pull", host: host.label, done, total });
    }

    // Overlap next pull RTT with open/exec of this batch.
    const nxt = batches[i + 1];
    if (nxt) {
      nextPull = pullBodies(conn, nxt);
    }

    if (onProgress) {
      onProgress({ phase: "open", host: host.label, done, total });
    }
    // Host may return bodies in any order; re-sort before open/exec.
    const ordered = sortByHlcDesc(pulled, (p) => p.dl.head);
    const [, openStat] = await openPulled(store, enclave, crypto, ordered);
    if (openStat !== Status.Success) {
      return openStat;
    }
    if (afterOpen) {
      if (onProgress) {
        onProgress({ phase: "exec", host: host.label, done, total });
      }
      await afterOpen();
    }
  }

  return Status.Success;
}

export function msg2StoredMsgData(
  { head, body }: IMsgParts,
  realm?: IKDM,
): IStoredMessageWrite {
  const data: IStoredMessageWrite = {
    eid: head.eid,
    body,
    apld: APLD_PENDING, // exec (or drainApplyQueue) sets APPLIED/ERROR
  };
  if (head.off !== 0) data.off = head.off;
  if (head.ctr !== 0) data.ctr = head.ctr;
  if (head.typ) data.typ = head.typ;
  const rlm = realmLabel(realm?.label);
  if (rlm !== undefined) data.rlm = rlm;
  return data;
}

/**
 * notif → open inline bodies into archive; enq incomplete → scheduleSync.
 * `scheduleSync` runs full peek/push/pull (or worker handoff).
 */
export async function handleNotif<Handle extends HostHandle>(
  bytes: Uint8Array,
  {
    conn,
    store,
    enclave,
    host,
    crypto,
    onProgress,
  }: ISyncParams<Handle>,
  scheduleSync: () => void,
) {
  const label = host.label;
  const [hostIdnt, ist] = await conn.identity();
  if (ist !== Status.Success) return;
  let verifyKey: CryptoKey;
  try {
    verifyKey = await crypto.importVerifyKey(hostIdnt.publicKey);
  } catch (e) {
    console.error("Failed importing host verify key", e);
    return;
  }

  const dec = new Decoder(bytes);
  const [notifItems, statBatch] = dec.readStructs(notifItemCodec);
  if (statBatch !== Status.Success) {
    console.error("Failed decoding notif", Status[statBatch]);
    return;
  }

  const hostKDM: IKDM = { label: host.label, index: host.idx ?? 0 };
  const known = realmKDMs(await store.realms.list());
  let outOfSeq = false;
  const currHost = await store.hosts.get(label);
  type Run = { realm: IKDM; seq: number };
  const runs = new Map<string, Run>();

  const completeBags: Array<{
    head: IMessageHead;
    headEnc: Uint8Array;
    headEncHash: Hash;
    bodyCph?: Uint8Array;
    kdm: Uint8Array;
    realm: IKDM;
  }> = [];
  let needPull = false;

  for (const item of notifItems) {
    const [realm, realmSt] = await enclave.realmForRlm(
      hostKDM,
      item.rlm,
      known,
    );
    if (realmSt !== Status.Success) {
      console.error("notif: realm", Status[realmSt]);
      continue;
    }
    const [peekItem, s2] = await decryptPeekItem(
      { seq: item.seq, headCph: item.headCph },
      verifyKey,
      enclave,
      crypto,
      item.rlm,
      realm,
    );
    if (s2 !== Status.Success) {
      console.error("Failed decrypting notif", Status[s2]);
      continue;
    }

    const headEncHash = await crypto.blake3(peekItem.headEnc);
    if (await store.messages.has(headEncHash)) {
      continue;
    }

    const headDec = new Decoder(peekItem.headEnc);
    const [head, headStatus] = headDec.readStruct(messageHeadCodec);
    if (headStatus !== Status.Success) {
      console.error("Failed to parse head", Status[headStatus]);
      continue;
    }

    // Inline body (or empty) can open now; otherwise enqueue a pull.
    if (!item.bodyCph && head.len > 0) {
      needPull = true;
      const dl: IDownloadMessage = {
        seq: item.seq,
        host: label,
        kdm: peekItem.kdm,
        head,
        headEnc: peekItem.headEnc,
        headEncHash,
      };
      const tagged = storedRealm(realm);
      if (tagged !== undefined) dl.realm = tagged;
      await store.downloads.enq([dl]);
    } else {
      completeBags.push({
        ...peekItem,
        head,
        bodyCph: item.bodyCph,
        headEncHash,
        realm,
      });
    }

    if (!currHost) {
      console.log("out of seq", item.seq, undefined);
      outOfSeq = true;
      continue;
    }
    const key = realmKey(realm);
    let run = runs.get(key);
    if (!run) {
      run = { realm, seq: cursorOf(currHost, realm) };
      runs.set(key, run);
    }
    if (item.seq !== run.seq + 1) {
      console.log("out of seq", item.seq, run.seq);
      outOfSeq = true;
    } else {
      run.seq = item.seq;
    }
  }

  if (currHost) {
    for (const run of runs.values()) {
      if (run.seq > cursorOf(currHost, run.realm)) {
        await store.hosts.touch(host.label, run.seq, run.realm);
      }
    }
  }

  const toStore: IStorableMessage[] = [];
  for (const input of completeBags) {
    const cipher = enclave.deriveCipher(input.kdm, "decrypt", input.realm);
    const [contents, stat] = await openBagBody(
      input.headEnc,
      input.bodyCph,
      cipher,
      crypto,
    );
    if (stat !== Status.Success) {
      console.error("Failed to open body", Status[stat]);
      continue;
    }
    toStore.push({
      key: input.headEncHash,
      data: msg2StoredMsgData(
        { head: input.head, body: contents.bod },
        input.realm,
      ),
    });
  }

  const statsStore = await store.messages.add(toStore);
  for (let i = 0; i < statsStore.length; i++) {
    const st = statsStore[i];
    if (st !== Status.Success && st !== Status.NoChange) {
      console.error("ERR storing", Status[st], "for message", i);
    }
  }

  if (onProgress && toStore.length > 0) {
    onProgress({
      phase: "open",
      host: host.label,
      done: toStore.length,
      total: toStore.length,
    });
  }

  if (outOfSeq || needPull || toStore.length > 0) {
    scheduleSync();
  }
}

/**
 * Full host inventory (PEEK from seq 0 in each realm): set that realm's cursor;
 * optionally enqueue downloads (msgs on host missing locally) and/or uploads
 * (local msgs missing on host). Returns ephemeral bag tallies + msgcheck (not
 * persisted). Does not pull/push beyond peek — caller should sync() to drain.
 *
 * Each cursor is the max bag seq in that realm (0 if empty), including rewind
 * when the host has fewer bags than a prior cursor believed.
 */
export async function reconcileHost<Handle extends HostHandle>(
  params: ISyncParams<Handle>,
  opts: ReconcileOpts = {},
): Promise<ValStat<ReconcileResult>> {
  const pull = opts.pull !== false;
  const push = opts.push === true;
  const {
    conn,
    store,
    enclave,
    host,
    crypto,
    onProgress,
    peekProgressEvery,
    peekConcurrency,
  } = params;

  const [hostIdnt, ist] = await conn.identity();
  if (ist !== Status.Success) return err(ist);
  let verifyKey: CryptoKey;
  try {
    verifyKey = await crypto.importVerifyKey(hostIdnt.publicKey);
  } catch {
    return err(Status.CryptoError);
  }

  // msgKey (archive key / blake3 of encoded msg header) → first bag + count
  type MsgAgg = {
    hash: Hash;
    count: number;
    sample: Extract<PeekCryptoResult, { ok: true }>;
    realm: IKDM;
  };
  const byMsg = new Map<string, MsgAgg>();
  let numBags = 0;
  const every = peekProgressEvery ?? defaultPeekProgressEvery;
  const conc = peekConcurrency ?? defaultPeekConcurrency;
  const realms = realmKDMs(await store.realms.list());

  for (const realm of realms) {
    const [rlm, rst] = await conn.hostRlm(realm);
    if (rst !== Status.Success) return err(rst);
    // Full inventory: ignore local cursor.
    const [items, peekStatus] = await conn.peek(0, realm);
    if (peekStatus !== Status.Success) return err(peekStatus);
    numBags += items.length;

    const total = items.length;
    if (onProgress && total > 0) {
      onProgress({ phase: "peek", host: host.label, done: 0, total });
    }

    let cryptoDone = 0;
    const cryptoResults = await mapPool(items, conc, async (item) => {
      const [itemDec, stat] = await decryptPeekItem(
        item,
        verifyKey,
        enclave,
        crypto,
        rlm,
        realm,
      );
      let result: PeekCryptoResult;
      if (stat !== Status.Success) {
        result = { ok: false, seq: item.seq, stat };
      } else {
        const headEncHash = await crypto.blake3(itemDec.headEnc);
        result = {
          ok: true,
          seq: item.seq,
          kdm: itemDec.kdm,
          headEnc: itemDec.headEnc,
          headEncHash,
        };
      }
      cryptoDone += 1;
      if (onProgress && shouldEmitItemProgress(cryptoDone, total, every)) {
        onProgress({
          phase: "peek",
          host: host.label,
          done: cryptoDone,
          total,
        });
      }
      return result;
    });

    for (const result of cryptoResults) {
      if (!result.ok) continue;
      const k = btob64(result.headEncHash);
      const cur = byMsg.get(k);
      if (cur) {
        cur.count += 1;
      } else {
        byMsg.set(k, {
          hash: result.headEncHash,
          count: 1,
          sample: result,
          realm,
        });
      }
    }

    const setLastSeq = items.length > 0
      ? Math.max(...items.map((i) => i.seq))
      : 0;
    await store.hosts.recordSeqs(host.label, { setLastSeq }, realm);

    if (onProgress) {
      onProgress({ phase: "peek", host: host.label, done: total, total });
    }
  }

  let numDupes = 0;
  const uniqueHashes: Hash[] = [];
  for (const agg of byMsg.values()) {
    if (agg.count > 1) numDupes += agg.count - 1;
    uniqueHashes.push(agg.hash);
  }
  const uniqueMsgs = byMsg.size;
  // Same set-checksum as local msgcheck (distinct msgs only; dup bags ignored).
  const hostMsgcheck = await checksumSet(uniqueHashes, crypto);

  const dls: IDownloadMessage[] = [];
  let missingLocal = 0;
  for (const agg of byMsg.values()) {
    const exists = await store.messages.has(agg.hash);
    if (exists) {
      // Host already has this msg — drop redundant upload if any.
      await store.uploads.deq(host.label, [agg.hash]);
      continue;
    }
    missingLocal += 1;
    if (!pull) continue;
    const r = agg.sample;
    const headDec = new Decoder(r.headEnc);
    const [head, headStatus] = headDec.readStruct(messageHeadCodec);
    if (headStatus !== Status.Success) {
      console.error("reconcile: reading msg header", headStatus);
      continue;
    }
    const dl: IDownloadMessage = {
      kdm: r.kdm,
      head,
      seq: r.seq,
      host: host.label,
      headEnc: r.headEnc,
      headEncHash: r.headEncHash,
    };
    const tagged = storedRealm(agg.realm);
    if (tagged !== undefined) dl.realm = tagged;
    dls.push(dl);
  }
  if (dls.length > 0) {
    await store.downloads.enq(dls);
  }

  let missingHost = 0;
  if (push) {
    const localKeys = await store.messages.listKeys();
    const hostKeys = new Set(byMsg.keys());
    const toUpload: Hash[] = [];
    for (const key of localKeys) {
      if (!hostKeys.has(btob64(key))) {
        missingHost += 1;
        toUpload.push(key);
      }
    }
    if (toUpload.length > 0) {
      await store.uploads.enq(host.label, toUpload);
    }
  } else {
    // Still count local msgs absent on host (no enqueue).
    const localKeys = await store.messages.listKeys();
    const hostKeys = new Set(byMsg.keys());
    for (const key of localKeys) {
      if (!hostKeys.has(btob64(key))) missingHost += 1;
    }
  }

  return ok({
    msgcheck: hostMsgcheck,
    numBags,
    uniqueMsgs,
    numDupes,
    missingLocal,
    missingHost,
  });
}
