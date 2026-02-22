import { openBagBody } from "./shared/bag";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { IMessageHead, messageHeadCodec } from "./shared/codecs/messageHead";
import { IBagPeekItem } from "./shared/codecs/peekItem";
import { peekItemHeadCodec } from "./shared/codecs/peekItemHead";
import { Status } from "./shared/consts";
import { Enclave } from "./shared/enclave";
import { EncodedMessage } from "./shared/message";
import { Hash, HostHandle, HostSpecificKeyPair, IBag, ICrypto, IMessage } from "./shared/types";
import { err, ok, ValStat } from "./shared/valstat";
import { IDownloadMessage, IHostRow, IStore, IStoredMessageData } from "./types";

async function parsePeekItem(item: IBagPeekItem, hostKeys: HostSpecificKeyPair, enclave: Enclave, crypto: ICrypto): Promise<ValStat<{ kdm: Uint8Array, head: IMessageHead }>> {
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
  const headDec = new Decoder(headEnc);
  const [head, headStatus] = headDec.readStruct(messageHeadCodec);
  if (headStatus !== Status.Success) {
    return err(headStatus);
  }
  return ok({ kdm, head });
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
    head: IMessageHead,
    body: EncodedMessage | undefined,
    upload: boolean,
  ) => Promise<Status>,
): Promise<Status> {
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
    const properHash = await crypto.blake3(headEnc);

    // Unseal body.
    const key = await enclave.deriveFromKDM(dl.kdm);
    const [contents, status] = await openBagBody(headEnc, bodyCph, key, crypto);
    if (status !== Status.Success) {
      // Failed to open bag.
      // This is not retry-able.
      dls.delete(seq);
      await store.downloads.deq(host.label, [seq]);
      continue;
    }

    // Store message.
    const { bod: body } = contents;
    const data: IStoredMessageData = {
      eid: head.eid,
      ...(head.off !== 0 ? { off: head.off } : {}),
      ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
      body
    };
    await store.messages.add(properHash, data);

    // Remove download.
    dls.delete(seq);
    await store.downloads.deq(host.label, [seq]);

    // Apply message to local state.
    // TODO: should apply happen before storing the message and deq-ing the download?
    // No. Application should be a separate phase.
    // Messages should be tagged with whether they've been applied or not.
    const stat = await apply(head, body, false);
    if (stat !== Status.Success) {
      console.error("ERR applying", stat);
    }
  }
  return Status.Success;
}
