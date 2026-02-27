import { openBagBody } from "./shared/bag";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { IMessageHead, messageHeadCodec } from "./shared/codecs/messageHead";
import { notifItemCodec } from "./shared/codecs/notifItem";
import { IBagPeekItem } from "./shared/codecs/peekItem";
import { peekItemHeadCodec } from "./shared/codecs/peekItemHead";
import { Status } from "./shared/consts";
import { Enclave } from "./shared/enclave";
import { Hash, HostHandle, HostSpecificKeyPair, IBag, ICrypto, IMessage } from "./shared/types";
import { err, ok, ValStat } from "./shared/valstat";
import { IDownloadMessage, IHostRow, IMsgParts, IStorableMessage, IStore, IStoredMessageData } from "./types";

export interface IDecryptedBagPeekItem {
  kdm: Uint8Array;
  headEnc: Uint8Array;
}
export async function decryptPeekItem(item: IBagPeekItem, hostKeys: HostSpecificKeyPair, enclave: Enclave, crypto: ICrypto): Promise<ValStat<IDecryptedBagPeekItem>> {
  const dec = new Decoder(item.headCph);
  const [peekItem, readStatus] = dec.readStruct(peekItemHeadCodec);
  if (readStatus !== Status.Success) {
    return err(readStatus);
  }
  const { sig, kdm, headCph } = peekItem;
  const valid = await crypto.checkSigEd25519(
    sig,
    headCph,
    hostKeys.publicKey,
  );
  if (!valid) {
    return err(Status.InvalidSignature);
  }
  const key = await enclave.deriveFromKDM(kdm);
  let headEnc: Uint8Array;
  try {
    headEnc = await crypto.decryptXSalsa20Poly1305Combined(headCph, key);
  } catch {
    // Decryption failed, skip
    return err(Status.DecryptionError);
  }
  return ok({ kdm, headEnc });
}

export async function parsePeekItem(item: IBagPeekItem, hostKeys: HostSpecificKeyPair, enclave: Enclave, crypto: ICrypto): Promise<ValStat<{ kdm: Uint8Array, head: IMessageHead }>> {
  const [itemDec, stat] = await decryptPeekItem(item, hostKeys, enclave, crypto);
  if (stat !== Status.Success) return err(stat);

  const headDec = new Decoder(itemDec.headEnc);
  const [head, headStatus] = headDec.readStruct(messageHeadCodec);
  if (headStatus !== Status.Success) {
    return err(headStatus);
  }
  return ok({ kdm: itemDec.kdm, head });
}

// Phase 1: Peek for new items and enqueue downloads
export async function syncPeek<Handle extends HostHandle>(
  conn: DiplomaticClientAPI<Handle>,
  store: IStore<Handle>,
  enclave: Enclave,
  clock: IClock,
  host: IHostRow<Handle>,
  crypto: ICrypto,
): Promise<Status> {
  // console.info("peeking...")
  const hostKeys = await conn.keys();
  const dls: IDownloadMessage[] = [];
  const [items, peekStatus] = await conn.peek(host.lastSeq);
  if (peekStatus !== Status.Success) {
    return peekStatus;
  }
  for (const item of items) {
    const [dlm, stat] = await parsePeekItem(item, hostKeys, enclave, crypto);
    if (stat !== Status.Success) {
      console.error("Parsing peek item", stat);
      continue;
      // NOTE: skipping here has the potential to create out-of-sync issues.
      // The resolution will be the CHECK mechanism to ensure client and host
      // have the same set of messages.
    }
    dls.push({ ...dlm, seq: item.seq, host: host.label });
  }
  await store.downloads.enq(dls);

  // Update host lastSeq to the max seq from peeked items.
  if (items.length > 0) {
    const maxSeq = Math.max(...items.map((i) => i.seq));
    await store.hosts.touch(host.label, maxSeq);
  }

  return Status.Success;
}

// Phase 2: Push local uploads to the host
export async function syncPush<Handle extends HostHandle>(
  conn: DiplomaticClientAPI<Handle>,
  store: IStore<Handle>,
  enclave: Enclave,
  clock: IClock,
  host: IHostRow<Handle>,
  crypto: ICrypto,
): Promise<Status> {
  // console.info("pushing...")
  // Form bags.
  const bags: IBag[] = [];
  const hashes: Hash[] = [];
  for (const msgHeadEncHash of await store.uploads.list(host.label)) {
    const storedMsg = await store.messages.get(msgHeadEncHash);
    if (!storedMsg) {
      continue;
    }
    const msg: IMessage = { ...storedMsg.head, bod: storedMsg.body };
    const bag = await conn.seal(msg);
    bags.push(bag);
    hashes.push(msgHeadEncHash);
  }

  // Push bags.
  if (bags.length < 1) {
    return Status.Success;
  }
  const [results, pushStatus] = await conn.push(bags);
  if (pushStatus !== Status.Success) {
    return pushStatus;
  }

  // Remove successful uploads from queue.
  for (const item of results) {
    if (item.status !== Status.Success) {
      // TODO: distinguish retry-able from non-retry-able errors.
      // Non-retry-able errors should be also removed from the upload queue,
      // but will require user feedback to indicate that the local state is
      // not *ever* going to be persisted to at least this particular host.
      console.error("push err", item);
      continue;
    }
    const msgHeadEncHash = hashes[item.idx];
    if (!msgHeadEncHash) {
      console.error("no hash", item);
      continue;
    }
    await store.uploads.deq(host.label, [msgHeadEncHash]);
  }

  // Update host lastSeq based on successful push seqs.
  if (results.length > 0) {
    let currentMax = host.lastSeq;
    const successfulSeqs = results
      .filter((item) => item.status === Status.Success)
      .map((item) => item.seq)
      .sort((a, b) => a - b);
    for (const seq of successfulSeqs) {
      if (seq === currentMax + 1) {
        currentMax = seq;
      }
    }
    if (currentMax > host.lastSeq) {
      await store.hosts.touch(host.label, currentMax);
    }
  }

  return Status.Success;
}

// Phase 3: Pull and process enqueued downloads
export async function syncPull<Handle extends HostHandle>(
  conn: DiplomaticClientAPI<Handle>,
  store: IStore<Handle>,
  enclave: Enclave,
  host: IHostRow<Handle>,
  crypto: ICrypto,
  apply: (
    parts: IMsgParts[],
    options?: { enqueueUpload: boolean; triggerUpload: boolean; },
  ) => Promise<Status[]>,
): Promise<Status> {
  // console.info("pulling...")
  const dls: Map<number, IDownloadMessage> = new Map();
  const allItems = await store.downloads.list();
  const items = Array.from(allItems).filter((i) => i.host === host.label);
  if (items.length < 1) {
    return Status.NoChange;
  }

  const seqs: number[] = [];
  for (const item of items) {
    dls.set(item.seq, item);
    seqs.push(item.seq);
  }
  const [result, stat] = await conn.pull(seqs);
  if (stat !== Status.Success) {
    return stat;
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

    // Decode message head.
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const headEnc = enc.result();
    const headEncHash = await crypto.blake3(headEnc);
    const key = await enclave.deriveFromKDM(dl.kdm);
    const [contents, stat] = await openBagBody(headEnc, bodyCph, key, crypto);
    if (stat !== Status.Success) {
      // Failed to open bag.
      // This is not retry-able.
      dls.delete(seq);
      await store.downloads.deq(host.label, [seq]);
      continue;
    }

    const parts: IMsgParts = { head, body: contents.bod };
    const data = msg2StoredMsgData(parts);
    const storable: IStorableMessage = { key: headEncHash, data };
    successfulParts.push(parts);
    messagesToStore.push(storable);
    seqsToDequeue.push(seq);
  }

  // Batch store messages.
  const statsStore = await store.messages.add(messagesToStore);

  // Batch dequeue downloads.
  // TODO: return batch status codes from this too.
  await store.downloads.deq(host.label, seqsToDequeue);

  // Batch apply messages to local state.
  const statsApply = await apply(successfulParts, { enqueueUpload: false, triggerUpload: false });
  // TODO: update stored messages to indicate which have been successfully applied, so they can be retried if not.

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

  return Status.Success;
}

export function msg2StoredMsgData({ head, body }: IMsgParts): IStoredMessageData {
  return {
    eid: head.eid,
    ...(head.off !== 0 ? { off: head.off } : {}),
    ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
    body
  };
}

export async function handleNotif<Handle extends HostHandle>(
  bytes: Uint8Array,
  conn: DiplomaticClientAPI<Handle>,
  store: IStore<Handle>,
  enclave: Enclave,
  host: IHostRow<Handle>,
  crypto: ICrypto,
  apply: (
    parts: IMsgParts[],
    options?: { enqueueUpload: boolean; triggerUpload: boolean; },
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
    const [peekItem, s2] = await decryptPeekItem({ seq: item.seq, headCph: item.headCph }, keys, enclave, crypto);
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
      const dlm: IDownloadMessage = { seq: item.seq, host: label, kdm: peekItem.kdm, head };
      // TODO: batch these (needs careful handling of seq).
      await store.downloads.enq([dlm]);
    } else {
      // Body is either present or non-existent.
      completeBags.push({ ...peekItem, head, bodyCph: item.bodyCph, headEncHash });
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
  if (lastSeq !== undefined) {
    await store.hosts.touch(host.label, lastSeq);
  }

  // Prepare to batch-process complete messages.
  const successfulParts: IMsgParts[] = [];
  const messagesToStore: IStorableMessage[] = [];
  for (const input of completeBags) {
    const key = await enclave.deriveFromKDM(input.kdm);
    const [contents, stat] = await openBagBody(input.headEnc, input.bodyCph, key, crypto);
    if (stat !== Status.Success) {
      console.error("Failed to open body", Status[stat]);
      continue;
    }

    const parts: IMsgParts = { head: input.head, body: contents.bod };
    const data = msg2StoredMsgData(parts)
    const storable: IStorableMessage = { key: input.headEncHash, data };
    messagesToStore.push(storable);
    successfulParts.push(parts);
  }

  // console.info("notif handler", successfulParts.length, messagesToStore.length, notifItems.length)

  // Batch store messages.
  const statsStore = await store.messages.add(messagesToStore);

  // Batch apply messages to local state.
  const statsApply = await apply(successfulParts, { enqueueUpload: false, triggerUpload: false });
  // TODO: update stored messages to indicate which have been successfully applied, so they can be retried if not.

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
    await syncPull(conn, store, enclave, host, crypto, apply);
  }
}
