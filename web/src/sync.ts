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
import { IMessageHead, messageHeadCodec } from "./shared/codecs/messageHead";
import { notifItemCodec } from "./shared/codecs/notifItem";
import { Status } from "./shared/consts";
import { Enclave } from "./shared/enclave";
import { decryptPeekItem } from "./shared/sync";
import { Hash, HostHandle, IBag, ICrypto, IMessage } from "./shared/types";
import { err, ok, ValStat } from "./shared/valstat";
import { btob64 } from "./shared/binary";
import {
  defaultPeekProgressEvery,
  ProgressFn,
  shouldEmitItemProgress,
} from "./progress";
import {
  IDownloadMessage,
  IHostRow,
  IMsgParts,
  IStorableMessage,
  IStore,
  type IStoredMessageWrite,
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
  "pull" | "push" | "peek" | "seal" | "keys"
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
}

/** Approximate on-wire bag size (sig + kdm + ciphers). Soft limit only. */
function bagBytes(bag: IBag): number {
  return bag.sig.length + bag.kdm.length + bag.headCph.length +
    bag.bodyCph.length;
}

/** Push one batch of sealed bags; deq successes; advance lastSeq from store. */
export async function pushBatch<Handle extends HostHandle>(
  conn: Pick<DiplomaticClientAPI<Handle>, "push">,
  store: IStore<Handle>,
  hostLabel: string,
  bags: IBag[],
  hashes: Hash[],
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
    let currentMax = row.lastSeq;
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
      await store.hosts.touch(hostLabel, currentMax);
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

  const dls = new Map<number, IDownloadMessage>();
  const seqs: number[] = [];
  for (const item of items) {
    dls.set(item.seq, item);
    seqs.push(item.seq);
  }

  const [result, stat] = await conn.pull(seqs);
  if (stat !== Status.Success) {
    // TODO: per-row pull errors (which seqs failed); track on download queue.
    return err(stat);
  }
  if (!result) {
    return err(Status.InvalidResponse);
  }

  const pulled: IPulled[] = [];
  for (const { seq, bodyCph } of result) {
    const dl = dls.get(seq);
    if (!dl) continue;
    pulled.push({ dl, bodyCph });
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
  // Group seqs by host so each downloads.deq is one store call.
  const deqByHost = new Map<string, number[]>();

  for (const { dl, bodyCph } of items) {
    const { head, kdm, seq, host } = dl;
    // Prefer headEnc/hash from peek (avoids re-encode + double blake3).
    const [resolved, headStat] = await resolveHeadEnc(dl, crypto);
    if (headStat !== Status.Success || !resolved) {
      const seqs = deqByHost.get(host) ?? [];
      seqs.push(seq);
      deqByHost.set(host, seqs);
      continue;
    }
    const { headEnc, headEncHash } = resolved;

    const key = await enclave.deriveFromKDM(kdm);
    const [contents, openStat] = await openBagBody(
      headEnc,
      bodyCph,
      key,
      crypto,
      headEncHash,
    );
    if (openStat !== Status.Success || !contents) {
      // Unopenable bag: drop from download queue (no retry). TODO: per-row open errors.
      const seqs = deqByHost.get(host) ?? [];
      seqs.push(seq);
      deqByHost.set(host, seqs);
      continue;
    }

    const p: IMsgParts = { head, body: contents.bod };
    const keyHash = contents.headHash;
    toStore.push({ key: keyHash, data: msg2StoredMsgData(p) });
    parts.push(p);
    hashes.push(keyHash);
    const seqs = deqByHost.get(host) ?? [];
    seqs.push(seq);
    deqByHost.set(host, seqs);
  }

  const statsStore = await store.messages.add(toStore);
  // TODO: return batch status codes from deq too.
  for (const [host, seqs] of deqByHost) {
    await store.downloads.deq(host, seqs);
  }

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

  const byHost = new Map<string, number[]>();
  for (const d of dls) {
    let hashB64: string | undefined;
    if (d.headEncHash) {
      hashB64 = btob64(d.headEncHash);
    } else {
      const [resolved, st] = await resolveHeadEnc(d, crypto);
      if (st !== Status.Success || !resolved) continue;
      hashB64 = btob64(resolved.headEncHash);
    }
    if (!want.has(hashB64)) continue;
    const seqs = byHost.get(d.host) ?? [];
    seqs.push(d.seq);
    byHost.set(d.host, seqs);
  }
  for (const [hostLabel, seqs] of byHost) {
    await store.downloads.deq(hostLabel, seqs);
  }
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
  }: ISyncParams<Handle>,
): Promise<Status> {
  const hostKeys = await conn.keys();
  const dls: IDownloadMessage[] = [];
  const [items, peekStatus] = await conn.peek(host.lastSeq);
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
      hostKeys,
      enclave,
      crypto,
    );
    let result: PeekCryptoResult;
    if (stat !== Status.Success || !itemDec) {
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
  for (const result of cryptoResults) {
    if (!result.ok) {
      // Skip desyncs client vs host until CHECK reconciles message sets.
      console.error("peek: decrypting item head", result.stat);
      continue;
    }

    const msgExists = await store.messages.has(result.headEncHash);
    if (msgExists) {
      // Already archived (import or prior sync): no download. Drop any stale
      // download-queue row and redundant upload (host already has this head).
      console.info("peek: local msg; skip download, deq upload");
      await store.uploads.deq(host.label, [result.headEncHash]);
      await store.downloads.deq(host.label, [result.seq]);
      continue;
    }

    const headDec = new Decoder(result.headEnc);
    const [head, headStatus] = headDec.readStruct(messageHeadCodec);
    if (headStatus !== Status.Success) {
      console.error("peek: reading item head", headStatus);
      continue;
    }

    dls.push({
      kdm: result.kdm,
      head,
      seq: result.seq,
      host: host.label,
      headEnc: result.headEnc,
      headEncHash: result.headEncHash,
    });
  }
  await store.downloads.enq(dls);

  // Host will not re-offer these seqs on later peeks.
  if (items.length > 0) {
    const maxSeq = Math.max(...items.map((i) => i.seq));
    await store.hosts.touch(host.label, maxSeq);
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

  const flush = async (): Promise<Status> => {
    if (bags.length < 1) {
      return Status.Success;
    }
    const n = bags.length;
    const st = await pushBatch(conn, store, host.label, bags, hashes);
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

  for (const msgHeadEncHash of pending) {
    const storedMsg = await store.messages.get(msgHeadEncHash);
    if (!storedMsg) {
      done += 1;
      continue;
    }
    const msg: IMessage = { ...storedMsg.head, bod: storedMsg.body };
    const [bag, statBag] = await conn.seal(msg);
    if (statBag !== Status.Success) {
      return statBag;
    }
    if (!bag) {
      return Status.InternalError;
    }
    const size = bagBytes(bag);

    if (bags.length > 0 && batchBytes + size > limit) {
      const st = await flush();
      if (st !== Status.Success) {
        return st;
      }
    }

    bags.push(bag);
    hashes.push(msgHeadEncHash);
    batchBytes += size;

    if (batchBytes >= limit) {
      const st = await flush();
      if (st !== Status.Success) {
        return st;
      }
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
    if (pullStat !== Status.Success || !pulled) {
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
): IStoredMessageWrite {
  return {
    eid: head.eid,
    ...(head.off !== 0 ? { off: head.off } : {}),
    ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
    body,
    apld: false, // exec (or drainApplyQueue) sets true after app apply
  };
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
  const keys = await conn.keys();

  const dec = new Decoder(bytes);
  const [notifItems, statBatch] = dec.readStructs(notifItemCodec);
  if (statBatch !== Status.Success) {
    console.error("Failed decoding notif", Status[statBatch]);
    return;
  }

  let outOfSeq = false;
  const currHost = await store.hosts.get(label);
  let lastSeq = currHost?.lastSeq;

  const completeBags: Array<{
    head: IMessageHead;
    headEnc: Uint8Array;
    headEncHash: Hash;
    bodyCph?: Uint8Array;
    kdm: Uint8Array;
  }> = [];
  let needPull = false;

  for (const item of notifItems) {
    const [peekItem, s2] = await decryptPeekItem(
      { seq: item.seq, headCph: item.headCph },
      keys,
      enclave,
      crypto,
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
      await store.downloads.enq([{
        seq: item.seq,
        host: label,
        kdm: peekItem.kdm,
        head,
        headEnc: peekItem.headEnc,
        headEncHash,
      }]);
    } else {
      completeBags.push({
        ...peekItem,
        head,
        bodyCph: item.bodyCph,
        headEncHash,
      });
    }

    const isOutOfSeq = lastSeq === undefined || item.seq !== lastSeq + 1;
    if (isOutOfSeq) {
      console.log("out of seq", item.seq, lastSeq);
      outOfSeq = true;
    } else {
      lastSeq = item.seq;
    }
  }

  // TODO: outOfSeq=true may bump lastSeq incorrectly.
  if (lastSeq !== undefined) {
    await store.hosts.touch(host.label, lastSeq);
  }

  const toStore: IStorableMessage[] = [];
  for (const input of completeBags) {
    const key = await enclave.deriveFromKDM(input.kdm);
    const [contents, stat] = await openBagBody(
      input.headEnc,
      input.bodyCph,
      key,
      crypto,
    );
    if (stat !== Status.Success) {
      console.error("Failed to open body", Status[stat]);
      continue;
    }
    toStore.push({
      key: input.headEncHash,
      data: msg2StoredMsgData({ head: input.head, body: contents.bod }),
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
