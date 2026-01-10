import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import { btoh, htob, uint8ArraysEqual } from "./shared/binary";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { messageHeadCodec } from "./shared/codecs/messageHead";
import { peekItemHeadCodec } from "./shared/codecs/peekItemHead";
import { Status } from "./shared/consts";
import { EncodedMessage, genDeleteHead, genInsertHead, genUpsertHead, IMessage, IMessageHead } from "./shared/message";
import { EntityID, Hash, HostHandle, IBag, IHostConnectionInfo, ITransport } from "./shared/types";
import { StateManager } from "./state";
import { IWebClient as IClient, IDiplomaticClientState, IDiplomaticClientXferState, IDownloadMessage, IStateEmitter, IStore, IStoredMessage } from "./types";

export class NeoClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  constructor(
    private clock: IClock,
    private state: StateManager,
    private store: IStore<Handle>,
    private transport: ITransport,
  ) {
    this.clientState = new StateEmitter(() => this.getClientState());
    this.xferState = new StateEmitter(() => this.getXferState());
  }

  private async getClientState(): Promise<IDiplomaticClientState> {
    const { store } = this;
    const enclave = await store.seed.load();
    const hosts = await store.hosts.list();
    return {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected: false, // TODO
    }
  }

  private async getXferState(): Promise<IDiplomaticClientXferState> {
    const { uploads, downloads } = this.store;
    const numUploads = await uploads.count();
    const numDownloads = await downloads.count();
    return { numDownloads, numUploads };
  }

  private async apply(head: IMessageHead, body?: EncodedMessage) {
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const headEnc = enc.result();
    const hash = await libsodiumCrypto.blake3(headEnc);
    const msg: IStoredMessage = { hash, head, body };
    // NOTE: important to enqueue upload before storing it.
    await this.store.uploads.enq([hash]);
    await this.store.messages.add([msg]);
  }

  public async insert(body: EncodedMessage) {
    const clk = this.clock.now();
    const head = await genInsertHead(clk, body, libsodiumCrypto);
    await this.apply(head, body);
  }

  public async upsert(eid: EntityID, body: EncodedMessage) {
    const clk = this.clock.now();
    const last = await this.store.messages.last(eid);
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = await genUpsertHead(eid, clk, ctr, body, libsodiumCrypto);
    await this.apply(msg, body);
  }

  public async delete(eid: EntityID) {
    const clk = this.clock.now();
    const last = await this.store.messages.last(eid);
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = genDeleteHead(eid, clk, ctr);
    await this.apply(msg);
  }

  public async sync() {
    const { connections, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }

    // Fetch and enqueue new bag headers.
    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }
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
        dls.push({ hash: item.hash as Hash, kdm, head, host: label })
      }
      await store.downloads.enq(dls);
      // TODO: update host lastSyncedAt (touch method?) using timestamp returned from host (may need to change API).
    }

    // Push local bags.
    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }
      const bags: IBag[] = [];
      const remoteToLocalHash: Map<string, string> = new Map();
      for (const msgHeadEncHash of await store.uploads.list()) {
        const storedMsg = await store.messages.get(msgHeadEncHash);
        if (!storedMsg) {
          continue;
        }
        const msg: IMessage = { ...storedMsg.head, bod: storedMsg.body };
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

    // Pull any new bag bodies.
    const dls: Map<string, IDownloadMessage> = new Map();
    const allItems = await store.downloads.list();
    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }
      const items = Array.from(allItems).filter(i => i.host === label);
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

        const body = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(bodyCph, key) as EncodedMessage;
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
  }

  public async wipe() {
    // TODO: implement (with precautions).
  }

  public async import(file: File) {
    // TODO: implement.
  }

  public async export(filename: string, extension?: string) {
    // TODO: implement.
  }

  // Manage stored host connections.
  public async link(host: IHostConnectionInfo<Handle>) {
    return this.store.hosts.add(host);
  }
  public async unlink(label: string) {
    return this.store.hosts.del(label);
  }

  // Manage active host connections.
  public async connect() {
    const { clock, store, transport } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      const conn = new DiplomaticClientAPI(enclave, libsodiumCrypto, host, clock, transport);
      await conn.register();
      // TODO: hook in to notifier (call listen).
      this.connections.set(host.label, conn);
    }
  }

  public async disconnect() {
    this.connections.clear();
  }
}
