import { btoh, htob, uint8ArraysEqual } from "./shared/binary";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { IMessageHead, messageHeadCodec } from "./shared/codecs/messageHead";
import { peekItemHeadCodec } from "./shared/codecs/peekItemHead";
import { Status } from "./shared/consts";
import { Enclave } from "./shared/enclave";
import { EncodedMessage } from "./shared/message";
import { Hash, HostHandle, ICrypto } from "./shared/types";
import { IDownloadMessage, IHostRow, IStore, IStoredMessage } from "./types";

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
  const [items, peekStatus] = await conn.peek(host.lastSyncedAt);
  if (peekStatus !== Status.Success) {
    return peekStatus;
  }
  for (const item of items) {
    const dec = new Decoder(item.headCph);
    const [peekItem, readStatus] = dec.readStruct(peekItemHeadCodec);
    if (readStatus !== Status.Success) {
      // TODO: handle error
      continue;
    }
    const { sig, kdm, headCph } = peekItem;
    const valid = await crypto.checkSigEd25519(
      sig,
      headCph,
      hostKeys.publicKey,
    );
    if (!valid) {
      // TODO: handle error non-silently.
      continue;
    }
    const key = await enclave.deriveFromKDM(kdm);
    let headEnc: Uint8Array;
    try {
      headEnc = await crypto.decryptXSalsa20Poly1305Combined(headCph, key);
    } catch {
      // Decryption failed, skip
      continue;
    }
    const headDec = new Decoder(headEnc);
    const [head, headStatus] = headDec.readStruct(messageHeadCodec);
    if (headStatus !== Status.Success) {
      // TODO: handle error
      continue;
    }
    dls.push({ hash: item.hash as Hash, kdm, head, host: host.label });
  }
  await store.downloads.enq(dls);

  // TODO: update host lastSyncedAt (touch method?) using timestamp returned from host (may need to change API).
  await store.hosts.touch(host.label, clock.now());

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
  const bags: any[] = [];
  const remoteToLocalHash: Map<string, string> = new Map();
  for (const msgHeadEncHash of await store.uploads.list()) {
    const storedMsg = await store.messages.get(msgHeadEncHash);
    if (!storedMsg) {
      continue;
    }
    const msg: any = { ...storedMsg.head, bod: storedMsg.body };
    const bag = await conn.seal(msg);
    bags.push(bag);
    const headCphHash = await crypto.sha256Hash(bag.headCph) as Hash;
    remoteToLocalHash.set(btoh(headCphHash), btoh(msgHeadEncHash));
  }
  if (bags.length > 0) {
    const [results, pushStatus] = await conn.push(bags);
    if (pushStatus !== Status.Success) {
      return pushStatus;
    }

    // Remove successful uploads from queue.
    for (const item of results) {
      if (item.status !== Status.Success) {
        // TODO: handle errors, some of which may be non-retryable.
        console.error("push err", item)
        continue;
      }
      // TODO: make uploads host-specific (add a host label column), so we don't dequeue for all hosts.
      const msgHeadEncHashHex = remoteToLocalHash.get(btoh(item.hash));
      if (!msgHeadEncHashHex) {
        console.error("no hash", item, btoh(item.hash))
        continue;
      }
      const msgHeadEncHash = htob(msgHeadEncHashHex) as Hash;
      await store.uploads.deq([msgHeadEncHash]);
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
    head: IMessageHead,
    body: EncodedMessage | undefined,
    upload: boolean,
  ) => Promise<Status>,
): Promise<Status> {
  const dls: Map<string, IDownloadMessage> = new Map();
  const allItems = await store.downloads.list();
  const items = Array.from(allItems).filter((i) => i.host === host.label);
  const hshs: Hash[] = [];
  for (const item of items) {
    dls.set(btoh(item.hash), item);
    hshs.push(item.hash);
  }
  const [result, stat] = await conn.pull(hshs);
  if (stat !== Status.Success) {
    return stat;
  }
  for (const { hash, bodyCph } of result) {
    const dl = dls.get(btoh(hash));
    if (!dl) {
      continue;
    }

    const key = await enclave.deriveFromKDM(dl.kdm);
    const { head } = dl;
    if (
      head.hsh === undefined && (bodyCph === undefined || bodyCph.length === 0)
    ) {
      const enc = new Encoder();
      enc.writeStruct(messageHeadCodec, head);
      const headEnc = enc.result();
      const properHash = await crypto.blake3(headEnc) as Hash;
      await store.messages.add([{ hash: properHash, head }]);
      dls.delete(btoh(hash));
      continue;
    }

    if (head.hsh === undefined) {
      // TODO: handle better than just removing d/l.
      dls.delete(btoh(hash));
      continue;
    }

    let body: any;
    try {
      body = await crypto.decryptXSalsa20Poly1305Combined(bodyCph, key) as any;
    } catch {
      // Decryption failed, skip
      dls.delete(btoh(hash));
      continue;
    }
    const hashChk = await crypto.blake3(body);
    if (uint8ArraysEqual(head.hsh, hashChk) !== true) {
      // TODO: handle better than just removing d/l.
      dls.delete(btoh(hash));
      continue;
    }
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, dl.head);
    const headEnc = enc.result();
    const properHash = await crypto.blake3(headEnc) as Hash;
    const msg: IStoredMessage = { hash: properHash, head: dl.head, body };
    await store.messages.add([msg]);
    dls.delete(btoh(hash));
    await store.downloads.deq([hash]);
    const stat = await apply(head, body, false);
    if (stat !== Status.Success) {
      console.error("ERR applying", stat);
    }
  }
  return Status.Success;
}
