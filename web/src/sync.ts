import libsodiumCrypto from './crypto';
import { btoh, htob, uint8ArraysEqual } from './shared/binary';
import DiplomaticClientAPI from './shared/client';
import { Decoder } from './shared/codec';
import { messageHeadCodec } from './shared/codecs/messageHead';
import { peekItemHeadCodec } from './shared/codecs/peekItemHead';
import { Status } from "./shared/consts";
import { Enclave } from './shared/enclave';
import { Hash, HostHandle } from './shared/types';
import { IDownloadMessage, IHostRow, IStore } from './types';

// Phase 1: Peek for new items and enqueue downloads
export async function syncPeek<Handle extends HostHandle>(
  conn: DiplomaticClientAPI<Handle>,
  store: IStore<Handle>,
  enclave: Enclave,
  host: IHostRow<Handle>
): Promise<void> {
  const hostKeys = await conn.keys();
  const dls: IDownloadMessage[] = [];
  const items = await conn.peek(host.lastSyncedAt);
  for (const item of items) {
    const dec = new Decoder(item.headCph);
    const { sig, kdm, headCph } = dec.readStruct(peekItemHeadCodec);
    const valid = await libsodiumCrypto.checkSigEd25519(sig, headCph, hostKeys.publicKey);
    if (!valid) {
      // TODO: handle error non-silently.
      continue;
    }
    const key = await enclave.deriveFromKDM(kdm);
    const headEnc = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(headCph, key);
    const headDec = new Decoder(headEnc);
    const head = headDec.readStruct(messageHeadCodec);
    dls.push({ hash: item.hash as Hash, kdm, head, host: host.label });
  }
  await store.downloads.enq(dls);
  // TODO: update host lastSyncedAt (touch method?) using timestamp returned from host (may need to change API).
}

// Phase 2: Push local uploads to the host
export async function syncPush<Handle extends HostHandle>(
  conn: DiplomaticClientAPI<Handle>,
  store: IStore<Handle>,
): Promise<void> {
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
    const headCphHash = await libsodiumCrypto.sha256Hash(bag.headCph) as Hash;
    remoteToLocalHash.set(btoh(headCphHash), btoh(msgHeadEncHash));
  }
  const results = await conn.push(bags);

  // Remove successful uploads from queue.
  for (const item of results) {
    if (item.status !== Status.Success) {
      // TODO: handle errors, some of which may be non-retryable.
      continue;
    }
    // TODO: make uploads host-specific (add a host label column), so we don't dequeue for all hosts.
    const msgHeadEncHashHex = remoteToLocalHash.get(btoh(item.hash));
    if (!msgHeadEncHashHex) {
      continue;
    }
    const msgHeadEncHash = htob(msgHeadEncHashHex) as Hash;
    await store.uploads.deq([msgHeadEncHash]);
  }
}

// Phase 3: Pull and process enqueued downloads
export async function syncPull<Handle extends HostHandle>(
  conn: DiplomaticClientAPI<Handle>,
  store: IStore<Handle>,
  enclave: Enclave,
  host: IHostRow<Handle>
): Promise<void> {
  const dls: Map<string, IDownloadMessage> = new Map();
  const allItems = await store.downloads.list();
  const items = Array.from(allItems).filter(i => i.host === host.label);
  const hshs: Hash[] = [];
  for (const item of items) {
    dls.set(btoh(item.hash), item);
    hshs.push(item.hash);
  }
  const result = await conn.pull(hshs);
  for (const { hash, bodyCph } of result) {
    const dl = dls.get(btoh(hash));
    if (!dl) {
      continue;
    }

    const key = await enclave.deriveFromKDM(dl.kdm);
    const { head } = dl;
    if (head.hsh === undefined && (bodyCph === undefined || bodyCph.length === 0)) {
      await store.messages.add([{ hash, head }]);
      dls.delete(btoh(hash));
      continue;
    }

    if (head.hsh === undefined) {
      // TODO: handle better than just removing d/l.
      dls.delete(btoh(hash));
      continue;
    }

    const body = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(bodyCph, key) as any;
    const hashChk = await libsodiumCrypto.blake3(body);
    if (uint8ArraysEqual(head.hsh, hashChk) !== true) {
      // TODO: handle better than just removing d/l.
      dls.delete(btoh(hash));
      continue;
    }
    await store.messages.add([{ hash, head: dl.head, body }]);
    dls.delete(btoh(hash));
    await store.downloads.deq([hash]);
  }
}
