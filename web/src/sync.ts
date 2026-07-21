// This file contains the DIPLOMATIC web client's sync logic.
// The sync procedure is split into 3 phases:
// 1. PEEK - fetch new message headers from a host.
// 2. PUSH - upload new messages to the host.
// 3. PULL - download messages from the host.

import { openBagBody } from "./shared/bag";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { IMessageHead, messageHeadCodec } from "./shared/codecs/messageHead";
import { notifItemCodec } from "./shared/codecs/notifItem";
import { Status } from "./shared/consts";
import { Enclave } from "./shared/enclave";
import { decryptPeekItem } from "./shared/sync";
import { Hash, HostHandle, IBag, ICrypto, IMessage } from "./shared/types";
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

export interface ISyncParams<Handle extends HostHandle> {
  conn: DiplomaticClientAPI<Handle>;
  store: IStore<Handle>;
  enclave: Enclave;
  clock: IClock;
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
      // TODO: distinguish retry-able from non-retry-able errors.
      console.error("push err", item);
      continue;
    }
    const msgHeadEncHash = hashes[item.idx];
    if (!msgHeadEncHash) {
      console.error("no hash", item);
      continue;
    }
    await store.uploads.deq(hostLabel, [msgHeadEncHash]);
  }

  // Re-fetch host so lastSeq is current (after peek / prior batches).
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

/** Pull one batch of download-queue items; store, deq, apply. */
export async function pullBatch<Handle extends HostHandle>(
  conn: Pick<DiplomaticClientAPI<Handle>, "pull">,
  store: IStore<Handle>,
  enclave: Enclave,
  hostLabel: string,
  crypto: ICrypto,
  items: IDownloadMessage[],
  apply: (
    parts: IMsgParts[],
    options?: { enqueueUpload: boolean; triggerUpload: boolean },
  ) => Promise<Status[]>,
): Promise<Status> {
  if (items.length < 1) {
    return Status.Success;
  }

  const dls = new Map<number, IDownloadMessage>();
  const seqs: number[] = [];
  for (const item of items) {
    dls.set(item.seq, item);
    seqs.push(item.seq);
  }

  const [result, stat] = await conn.pull(seqs);
  if (stat !== Status.Success) {
    return stat;
  }
  if (!result) {
    return Status.InvalidResponse;
  }

  const successfulParts: IMsgParts[] = [];
  const messagesToStore: IStorableMessage[] = [];
  const seqsToDequeue: number[] = [];

  for (const { seq, bodyCph } of result) {
    const dl = dls.get(seq);
    if (!dl) {
      continue;
    }
    const { head } = dl;

    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const headEnc = enc.result();
    const headEncHash = await crypto.blake3(headEnc);
    const key = await enclave.deriveFromKDM(dl.kdm);
    const [contents, openStat] = await openBagBody(
      headEnc,
      bodyCph,
      key,
      crypto,
    );
    if (openStat !== Status.Success) {
      // Failed to open bag. Not retry-able.
      await store.downloads.deq(hostLabel, [seq]);
      continue;
    }

    const parts: IMsgParts = { head, body: contents.bod };
    const data = msg2StoredMsgData(parts);
    messagesToStore.push({ key: headEncHash, data });
    successfulParts.push(parts);
    seqsToDequeue.push(seq);
  }

  const statsStore = await store.messages.add(messagesToStore);
  // TODO: return batch status codes from deq too.
  await store.downloads.deq(hostLabel, seqsToDequeue);

  const statsApply = await apply(successfulParts, {
    enqueueUpload: false,
    triggerUpload: false,
  });
  // TODO: mark applied messages for retry on apply failure.

  for (let i = 0; i < statsApply.length; i++) {
    const statStore = statsStore[i];
    if (statStore !== Status.Success && statStore !== Status.NoChange) {
      console.error("ERR storing", Status[statStore], "for message", i);
    }
    const statApply = statsApply[i];
    if (statApply !== Status.Success && statApply !== Status.NoChange) {
      console.error("ERR applying", Status[statApply], "for message", i);
    }
  }

  return Status.Success;
}

// Phase 1: Peek for new items and enqueue downloads
export async function syncPeek<Handle extends HostHandle>(
  {
    conn,
    store,
    enclave,
    host,
    crypto,
    onProgress,
    peekProgressEvery,
  }: ISyncParams<Handle>,
): Promise<Status> {
  // console.info("peeking...")
  const hostKeys = await conn.keys();
  const dls: IDownloadMessage[] = [];
  const [items, peekStatus] = await conn.peek(host.lastSeq);
  if (peekStatus !== Status.Success) {
    return peekStatus;
  }
  const total = items.length;
  const every = peekProgressEvery ?? defaultPeekProgressEvery;
  if (onProgress && total > 0) {
    onProgress({ phase: "peek", host: host.label, done: 0, total });
  }
  let processed = 0;
  for (const item of items) {
    const [itemDec, stat] = await decryptPeekItem(
      item,
      hostKeys,
      enclave,
      crypto,
    );
    if (stat !== Status.Success) {
      console.error("peek: decrypting item head", stat);
      processed += 1;
      if (
        onProgress &&
        shouldEmitItemProgress(processed, total, every)
      ) {
        onProgress({
          phase: "peek",
          host: host.label,
          done: processed,
          total,
        });
      }
      continue;
      // NOTE: skipping here has the potential to create out-of-sync issues.
      // The resolution will be the CHECK mechanism to ensure client and host
      // have the same set of messages.
    }

    const headEncHash = await crypto.blake3(itemDec.headEnc);
    const msgExists = await store.messages.has(headEncHash);
    if (msgExists) {
      console.info("peek: skipping download enqueue");
      await store.uploads.deq(host.label, [headEncHash]);
      processed += 1;
      if (
        onProgress &&
        shouldEmitItemProgress(processed, total, every)
      ) {
        onProgress({
          phase: "peek",
          host: host.label,
          done: processed,
          total,
        });
      }
      continue;
    }

    const headDec = new Decoder(itemDec.headEnc);
    const [head, headStatus] = headDec.readStruct(messageHeadCodec);
    if (headStatus !== Status.Success) {
      console.error("peek: reading item head", headStatus);
      processed += 1;
      if (
        onProgress &&
        shouldEmitItemProgress(processed, total, every)
      ) {
        onProgress({
          phase: "peek",
          host: host.label,
          done: processed,
          total,
        });
      }
      continue;
    }

    dls.push({ kdm: itemDec.kdm, head, seq: item.seq, host: host.label });
    processed += 1;
    if (
      onProgress &&
      shouldEmitItemProgress(processed, total, every)
    ) {
      onProgress({
        phase: "peek",
        host: host.label,
        done: processed,
        total,
      });
    }
  }
  await store.downloads.enq(dls);

  // Update host lastSeq to the max seq from peeked items.
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

// Phase 2: Push local uploads to the host.
// Snapshot once, seal, pack by soft byte budget, pushBatch each pack.
export async function syncPush<Handle extends HostHandle>(
  { conn, store, host, maxPushBytes, onProgress }: ISyncParams<Handle>,
): Promise<Status> {
  const limit = maxPushBytes ?? defaultMaxPushBytes;
  // Snapshot: do not re-list between batches.
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

// Phase 3: Pull and process enqueued downloads.
// Snapshot once, pack by head.len, pullBatch each pack.
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
  apply: (
    parts: IMsgParts[],
    options?: { enqueueUpload: boolean; triggerUpload: boolean },
  ) => Promise<Status[]>,
): Promise<Status> {
  const limit = maxPullBytes ?? defaultMaxPullBytes;
  const allItems = await store.downloads.list();
  // Snapshot: do not re-list between batches.
  const items = Array.from(allItems).filter((i) => i.host === host.label);
  if (items.length < 1) {
    return Status.NoChange;
  }

  const total = items.length;
  let done = 0;
  if (onProgress) {
    onProgress({ phase: "pull", host: host.label, done: 0, total });
  }

  let batch: IDownloadMessage[] = [];
  let batchBytes = 0;

  const flush = async (): Promise<Status> => {
    if (batch.length < 1) {
      return Status.Success;
    }
    const n = batch.length;
    const st = await pullBatch(
      conn,
      store,
      enclave,
      host.label,
      crypto,
      batch,
      apply,
    );
    batch = [];
    batchBytes = 0;
    if (st === Status.Success) {
      done += n;
      if (onProgress) {
        onProgress({ phase: "pull", host: host.label, done, total });
        onProgress({
          phase: "apply",
          host: host.label,
          done,
          total,
        });
      }
    }
    return st;
  };

  for (const item of items) {
    const size = item.head.len;

    if (batch.length > 0 && batchBytes + size > limit) {
      const st = await flush();
      if (st !== Status.Success) {
        return st;
      }
    }

    batch.push(item);
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

export function msg2StoredMsgData(
  { head, body }: IMsgParts,
): IStoredMessageWrite {
  return {
    eid: head.eid,
    ...(head.off !== 0 ? { off: head.off } : {}),
    ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
    body,
    // Pending apply until SyncClient.apply / drainApplyQueue.
    apld: false,
  };
}

export async function handleNotif<Handle extends HostHandle>(
  bytes: Uint8Array,
  {
    conn,
    store,
    enclave,
    host,
    crypto,
    clock,
    maxPullBytes,
    maxPushBytes,
    onProgress,
    peekProgressEvery,
  }: ISyncParams<Handle>,
  apply: (
    parts: IMsgParts[],
    options?: { enqueueUpload: boolean; triggerUpload: boolean },
  ) => Promise<Status[]>,
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
  const seqsToPull: number[] = [];

  for (const item of notifItems) {
    // Decrypt.
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

    // Skip pre-existing messages.
    const headEncHash = await crypto.blake3(peekItem.headEnc);
    if (await store.messages.has(headEncHash)) {
      continue;
    }

    // Parse head.
    const headDec = new Decoder(peekItem.headEnc);
    const [head, headStatus] = headDec.readStruct(messageHeadCodec);
    if (headStatus !== Status.Success) {
      console.error("Failed to parse head", Status[headStatus]);
      continue;
    }

    // Enqueue body download if body exists but is not inlined.
    if (!item.bodyCph && head.len > 0) {
      seqsToPull.push(item.seq);
      const dlm: IDownloadMessage = {
        seq: item.seq,
        host: label,
        kdm: peekItem.kdm,
        head,
      };
      // TODO: batch these (needs careful handling of seq).
      await store.downloads.enq([dlm]);
    } else {
      // Body is either present or non-existent.
      completeBags.push({
        ...peekItem,
        head,
        bodyCph: item.bodyCph,
        headEncHash,
      });
    }

    // Handle sequence.
    const isOutOfSeq = lastSeq === undefined || item.seq !== lastSeq + 1;
    if (isOutOfSeq) {
      console.log("out of seq", item.seq, lastSeq);
      outOfSeq = true;
    } else {
      lastSeq = item.seq;
    }
  }

  // Bump host sequence to last in batch.
  // TODO: test case where outOfSeq = true. Looks like seq could be erroneously bumped then.
  if (lastSeq !== undefined) {
    await store.hosts.touch(host.label, lastSeq);
  }

  // Prepare to batch-process complete messages.
  const successfulParts: IMsgParts[] = [];
  const messagesToStore: IStorableMessage[] = [];
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

    const parts: IMsgParts = { head: input.head, body: contents.bod };
    const data = msg2StoredMsgData(parts);
    const storable: IStorableMessage = { key: input.headEncHash, data };
    messagesToStore.push(storable);
    successfulParts.push(parts);
  }

  // console.info("notif handler", successfulParts.length, messagesToStore.length, notifItems.length)

  // Batch store messages.
  const statsStore = await store.messages.add(messagesToStore);

  // Batch apply messages to local state.
  const statsApply = await apply(successfulParts, {
    enqueueUpload: false,
    triggerUpload: false,
  });
  // TODO: update stored messages to indicate which have been successfully applied, so they can be retried if not.

  if (onProgress && successfulParts.length > 0) {
    onProgress({
      phase: "apply",
      host: host.label,
      done: successfulParts.length,
      total: successfulParts.length,
    });
  }

  // Handle errors.
  for (let i = 0; i < statsApply.length; i++) {
    const statStore = statsStore[i];
    if (statStore !== Status.Success && statStore !== Status.NoChange) {
      console.error("ERR storing", Status[statStore], "for message", i);
    }
    // const statDequeue = statsDequeue[i];
    // if (statDequeue !== Status.Success && statDequeue !== Status.NoChange) {
    //   console.error("ERR applying", Status[statDequeue], "for message", i);
    // }
    const statApply = statsApply[i];
    if (statApply !== Status.Success && statApply !== Status.NoChange) {
      console.error("ERR applying", Status[statApply], "for message", i);
    }
  }

  // Handle out-of-sequence.
  if (outOfSeq) {
    scheduleSync();
  } else {
    await syncPull(
      {
        conn,
        store,
        enclave,
        host,
        crypto,
        clock,
        maxPullBytes,
        maxPushBytes,
        onProgress,
        peekProgressEvery,
      },
      apply,
    );
  }
}
