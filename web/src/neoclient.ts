import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import { msgKey } from "./shared/bag";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { messageHeadCodec } from "./shared/codecs/messageHead";
import { peekItemHeadCodec } from "./shared/codecs/peekItemHead";
import { hostKeys } from "./shared/endpoint";
import { EncodedMessage, genDeleteHead, genInsertHead, genUpsertHead, IMessageHead } from "./shared/message";
import { EntityID, Hash, HostHandle, IHostConnectionInfo, ITransport } from "./shared/types";
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
    await this.apply(head);
  }

  public async upsert(eid: EntityID, body: EncodedMessage) {
    const clk = this.clock.now();
    const last = await this.store.messages.last(eid);
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = genUpsertHead(eid, clk, ctr, body);
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
        dls.push({ hash: item.hash as Hash, head, host: label })
      }
      store.downloads.enq(dls);
      // TODO: update host lastSyncedAt (touch method?) using timestmap returned from host (may need to change API).
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
