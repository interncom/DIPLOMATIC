import { encode } from "@msgpack/msgpack";
import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Encoder } from "./shared/codec";
import { messageHeadCodec } from "./shared/codecs/messageHead";
import {
  EncodedMessage,
  genInsertHead,
  genUpsertHead,
  IMessageHead,
} from "./shared/message";
import {
  EntityID,
  HostHandle,
  ICrypto,
  IHostConnectionInfo,
  IInsertParams,
  ITransport,
  IUpsertParams,
  MasterSeed,
} from "./shared/types";
import { syncPeek, syncPull, syncPush } from "./sync";
import {
  IClient,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IStateEmitter,
  IStateManager,
  IStore,
  IStoredMessage,
} from "./types";
import { Status } from "./shared/consts";
import { decodeFile, defaultFileExtension, encodeFile } from "./shared/exim";
import { saveAs } from "file-saver";
import { err, ok } from "./shared/valstat";

export class SyncClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  constructor(
    private clock: IClock,
    private state: IStateManager,
    private store: IStore<Handle>,
    private transport: ITransport,
    private crypto: ICrypto = libsodiumCrypto,

    // Client can be set to always force skew handling, to hide the pain.
    private forceSkewHandlingByDefault = true,
  ) {
    this.clientState = new StateEmitter(() => this.getClientState());
    this.xferState = new StateEmitter(() => this.getXferState());
  }

  public async setSeed(seed: MasterSeed) {
    await this.store.seed.save(seed);
    this.clientState.emit();
  }

  private async getClientState(): Promise<IDiplomaticClientState> {
    const { store } = this;
    const enclave = await store.seed.load();
    const hosts = await store.hosts.list();
    return {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected: false, // TODO
    };
  }

  private async getXferState(): Promise<IDiplomaticClientXferState> {
    const { uploads, downloads } = this.store;
    const numUploads = await uploads.count();
    const numDownloads = await downloads.count();
    return { numDownloads, numUploads };
  }

  private async apply(
    head: IMessageHead,
    body: EncodedMessage | undefined,
    upload = true,
  ) {
    const enc = new Encoder();
    enc.writeStruct(messageHeadCodec, head);
    const headEnc = enc.result();
    const hash = await this.crypto.blake3(headEnc);
    const msg: IStoredMessage = { hash, head, body };

    // If message is being applied via sync, don't upload.
    if (upload) {
      // NOTE: important to enqueue upload before storing it.
      await this.store.uploads.enq([hash]);
    }

    await this.store.messages.add([msg]);

    // TODO: decide what should happen if there's an error while applying.
    // Dequeue upload and remove message?
    const stat = await this.state.apply({ ...head, bod: body });
    return stat;
  }

  public async insertRaw(body: EncodedMessage) {
    const { clock, crypto } = this;
    const head = await genInsertHead(clock.now(), body, crypto);
    await this.apply(head, body);
    return ok(head);
  }

  public async upsertRaw(eid: EntityID, clk: Date, body: EncodedMessage | undefined, force = false) {
    const { clock, crypto, store } = this;
    const now = clock.now();
    const last = await store.messages.last(eid, clk);
    if (last) {
      const ts = last.head.clk.getTime() + last.head.off;
      if (ts > now.getTime()) {
        // last was created in the future. So either:
        // a) another client's clock is skewed into the future, or
        // b) this client's clock is skewed into the past.

        if (force === false) {
          return err<IMessageHead>(Status.ClockOutOfSync);
        }

        // We need to recover from skew.
        // We do so by deleting the invalid entity and replacing it.
        // To overwrite the skewed entity, the delete must increment off,
        // even if that places the delete into the future as well.
        const offDel = last.head.off + 1;
        const offCtr = last.head.ctr + 1;
        const delHead = { eid, clk, off: offDel, ctr: offCtr, len: 0 };
        const statDel = await this.apply(delHead, undefined);
        if (statDel !== Status.Success) {
          return err<IMessageHead>(statDel);
        }

        if (body === undefined) {
          // This upsert was a delete.
          // Therefore, we're done.
          // There's no replacement left to insert.
          return ok(delHead);
        }

        // Replace with a new msg that retains the old id.
        // The clk portion of the ID will be now.
        const clkRepl = now;
        const repl = await genUpsertHead(now, eid, clkRepl, 0, body, crypto);
        await this.apply(repl, body);
        return ok(repl);
      }
    }
    const ctr = (last?.head.ctr ?? -1) + 1;
    const msg = await genUpsertHead(now, eid, clk, ctr, body, crypto);
    await this.apply(msg, body);
    return ok(msg);
  }

  public async insert<T = unknown>(op: IInsertParams<T>) {
    const body = encode(op);
    return this.insertRaw(body);
  }

  public async upsert<T = unknown>(op: IUpsertParams<T>, force = this.forceSkewHandlingByDefault) {
    const { eid, clk, ...rest } = op;
    if (eid === undefined || clk === undefined) {
      return this.insert(op);
    }
    const body = encode(rest);
    return this.upsertRaw(eid, clk, body, force);
  }

  public async delete(eid: EntityID, clk: Date) {
    // NOTE: force (clock-skew handling) is set to true here.
    // When deleting, there's no reason not to force skew handling.
    return this.upsertRaw(eid, clk, undefined, true);
  }

  public async sync() {
    const { clock, connections, crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }

    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }
      const peekStat = await syncPeek(
        conn,
        store,
        enclave,
        clock,
        host,
        crypto,
      );
      if (peekStat !== Status.Success) {
        console.error(`Failed to peek: ${peekStat}`);
      }
      const pushStat = await syncPush(
        conn,
        store,
        enclave,
        clock,
        host,
        crypto,
      );
      if (pushStat !== Status.Success) {
        console.error(`Failed to push: ${pushStat}`);
      }
      const pullStat = await syncPull(
        conn,
        store,
        enclave,
        host,
        crypto,
        this.apply.bind(this),
      );
      if (pullStat !== Status.Success) {
        console.error(`Failed to pull: ${pullStat}`);
      }
    }
  }

  public async wipe() {
    await this.disconnect();
    await this.store.wipe();
    this.clientState.emit();
    this.xferState.emit();
  }

  public async import(file: File) {
    const { crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) return Status.MissingSeed;

    const bytes = await file.bytes();
    const [msgs, statDec] = await decodeFile(bytes, crypto, enclave);
    if (statDec !== Status.Success) return statDec;

    for (const msg of msgs) {
      const statApp = await this.apply(msg.head, msg.body, true);
      if (statApp !== Status.Success) return statApp;
    }

    return Status.Success;
  }

  public async export(filename: string, extension = defaultFileExtension) {
    const { crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) return Status.MissingSeed;

    const msgs = await store.messages.list();
    const [bytes, stat] = await encodeFile("export", 0, msgs, crypto, enclave);
    if (stat !== Status.Success) return stat;

    const blob = new Blob([bytes.slice()]);
    saveAs(blob, filename);
    return Status.Success;
  }

  // Manage stored host connections.
  public async link(host: IHostConnectionInfo<Handle>) {
    return this.store.hosts.add(host);
  }
  public async unlink(label: string) {
    return this.store.hosts.del(label);
  }

  // Manage active host connections.
  public async connect(listen = true) {
    const { clock, store, transport } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      const conn = new DiplomaticClientAPI(
        enclave,
        libsodiumCrypto,
        host,
        clock,
        transport,
      );
      await conn.register();
      if (listen) {
        const recv = (data: Uint8Array) => {
          this.sync().catch((err) => console.error("Sync failed:", err));
        };
        await conn.listen(recv);
      }
      this.connections.set(host.label, conn);
    }
  }

  public async disconnect() {
    this.connections.clear();
  }
}
