// This is the web client for DIPLOMATIC.

import { encode } from "@msgpack/msgpack";
import { saveAs } from "file-saver";
import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { eidCodec, makeEID } from "./shared/codecs/eid";
import { messageHeadCodec } from "./shared/codecs/messageHead";
import { Status } from "./shared/consts";
import { decodeFile, encodeFile } from "./shared/exim";
import { EncodedMessage, genInsertHead, genUpsertHead } from "./shared/message";
import {
  EntityID,
  Hash,
  HostHandle,
  ICrypto,
  IHostConnectionInfo,
  IInsertParams,
  IMessage,
  IMessageHead,
  IMsgEntBody,
  IStateManager,
  ITransport,
  IUpsertParams,
  MasterSeed,
} from "./shared/types";
import { err, ok, ValStat } from "./shared/valstat";
import { handleNotif, ISyncParams, syncPeek, syncPull, syncPush } from "./sync";
import {
  IClient,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IHostRow,
  IMsgParts,
  IStateEmitter,
  IStore,
  IStoredMessageData,
} from "./types";

export class SyncClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();
  private currentSync: Promise<Status> | null = null;

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  constructor(
    private clock: IClock,
    private state: IStateManager,
    private store: IStore<Handle>,
    private transport: (host: IHostConnectionInfo<Handle>) => ITransport,
    private crypto: ICrypto = libsodiumCrypto,
    // Client can be set to always force skew handling, to hide the pain.
    private forceSkewHandlingByDefault = true,
  ) {
    this.clientState = new StateEmitter(() => this.getClientState());

    this.xferState = new StateEmitter(() => this.getXferState());
  }

  private readonly SYNC_DEBOUNCE_DELAY_MS = 100;

  private syncTimeout: ReturnType<typeof setTimeout> | null = null;

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

  private apply = async (
    parts: IMsgParts[],
    options: { enqueueUpload: boolean; triggerUpload: boolean } = {
      enqueueUpload: true,
      triggerUpload: true,
    },
  ): Promise<Status[]> => {
    const hashes: Hash[] = [];
    const storables: { key: Hash; data: IStoredMessageData }[] = [];
    const msgs: IMessage[] = [];

    // Process parts into:
    // 1. hashes for upload queueing,
    // 2. storables for message archive,
    // 3. msgs for application to state.
    // console.time("apply: processing parts...")
    for (const { head, body } of parts) {
      const enc = new Encoder();
      enc.writeStruct(messageHeadCodec, head);
      const headEnc = enc.result();
      const hash = await this.crypto.blake3(headEnc);
      const data: IStoredMessageData = {
        eid: head.eid,
        ...(head.off !== 0 ? { off: head.off } : {}),
        ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
        body,
      };
      hashes.push(hash);
      storables.push({ key: hash, data });
      msgs.push({ ...head, bod: body });
    }
    // console.timeEnd("apply: processing parts...")

    // If message is being applied via sync, don't upload.
    if (options.enqueueUpload) {
      // NOTE: important to enqueue upload before storing it.
      const hosts = await this.store.hosts.list();
      for (const host of hosts) {
        await this.store.uploads.enq(host.label, hashes);
      }
      this.xferState.emit();
      // Clear any existing timeout to reset debounce
      if (this.syncTimeout !== null) {
        clearTimeout(this.syncTimeout);
      }
    }
    if (options.triggerUpload) {
      this.scheduleSync();
    }

    // console.time("apply: storing messages...")
    await this.store.messages.add(storables);
    // console.timeEnd("apply: storing messages...")

    // TODO: decide what should happen if there's an error while applying.
    // Dequeue upload and remove message?
    // console.time("apply: applying state updates...")
    const stats = await this.state.apply(msgs);
    // console.timeEnd("apply: applying state updates...")
    return stats;
  };

  public async insertRaw(bod: EncodedMessage) {
    const { clock, crypto } = this;
    const [head, stat] = await genInsertHead({ now: clock.now(), bod, crypto });
    if (stat !== Status.Success) {
      return err<IMessageHead>(stat);
    }
    await this.apply([{ head, body: bod }]);
    return ok(head);
  }

  public async upsertRaw(
    eid: EntityID,
    bod: EncodedMessage | undefined,
    force = false,
  ): Promise<ValStat<IMessageHead>> {
    const { clock, crypto, store } = this;
    const now = clock.now();
    const last = await store.messages.last(eid);
    if (last) {
      const decEid = new Decoder(eid);
      const [eidDec, statEid] = decEid.readStruct(eidCodec);
      if (statEid !== Status.Success) {
        return err<IMessageHead>(statEid);
      }

      const ts = eidDec.ts.getTime() + last.head.off;
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
        const delHead = { eid, off: offDel, ctr: offCtr, len: 0 };
        const statsDel = await this.apply([{ head: delHead, body: undefined }]);
        const statDel = statsDel[0];
        if (statDel !== Status.Success) {
          return err<IMessageHead>(statDel);
        }

        if (bod === undefined) {
          // This upsert was a delete.
          // Therefore, we're done.
          // There's no replacement left to insert.
          return ok(delHead);
        }

        // Replace with a new msg that retains the old eid but clk of now.
        const [replEID, statReplEID] = makeEID({ id: eidDec.id, ts: now });
        if (statReplEID !== Status.Success) {
          return err<IMessageHead>(statReplEID);
        }
        const replParams = { now, eid: replEID, ctr: 0, bod, crypto };
        const [repl, statRepl] = await genUpsertHead(replParams);
        if (statRepl !== Status.Success) {
          return err<IMessageHead>(statRepl);
        }
        const statsApply = await this.apply([{ head: repl, body: bod }]);
        const statApply = statsApply[0];
        if (statApply !== Status.Success) {
          return err<IMessageHead>(statApply);
        }
        return ok(repl);
      }
    }
    const ctr = (last?.head.ctr ?? -1) + 1;
    const [msg, statMsg] = await genUpsertHead({ now, eid, ctr, bod, crypto });
    if (statMsg !== Status.Success) {
      return err<IMessageHead>(statMsg);
    }
    const statsApply = await this.apply([{ head: msg, body: bod }]);
    const statApply = statsApply[0];
    if (statApply !== Status.Success) {
      return err<IMessageHead>(statApply);
    }
    return ok(msg);
  }

  public async insert<T = unknown>(op: IInsertParams<T>) {
    const { body, type, gid, pid } = op;
    const entBody: IMsgEntBody = { body, type, gid, pid };
    const entBodyEnc = encode(entBody);
    return this.insertRaw(entBodyEnc);
  }

  public async upsert<T = unknown>(
    op: IUpsertParams<T>,
    force = this.forceSkewHandlingByDefault,
  ) {
    const { eid, body, type, gid, pid } = op;
    if (eid === undefined) {
      return this.insert(op);
    }
    const entBody: IMsgEntBody = { body, type, gid, pid };
    const entBodyEnc = encode(entBody);
    return this.upsertRaw(eid, entBodyEnc, force);
  }

  public async delete(eid: EntityID) {
    // NOTE: force (clock-skew handling) is set to true here.
    // When deleting, there's no reason not to force skew handling.
    return this.upsertRaw(eid, undefined, true);
  }

  public async genEID(id?: Uint8Array): Promise<ValStat<EntityID>> {
    const { clock, crypto } = this;
    const ts = clock.now();
    if (id !== undefined) {
      return makeEID({ id, ts });
    }
    const randId = await crypto.genRandomBytes(8);
    return makeEID({ id: randId, ts });
  }

  public async sync(): Promise<Status> {
    if (this.currentSync) {
      await this.currentSync;
    }
    this.currentSync = this.doSync();
    return await this.currentSync;
  }

  private async doSync(): Promise<Status> {
    const { clock, connections, crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return Status.MissingSeed;
    }

    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }

      const syncParams: ISyncParams<Handle> = {
        conn,
        store,
        enclave,
        clock,
        host,
        crypto,
      };

      const peekStat = await syncPeek(syncParams);
      if (peekStat !== Status.Success) {
        console.error(`Failed to peek: ${peekStat}`);
        return peekStat;
      }
      this.xferState.emit();

      const pushStat = await syncPush(syncParams);
      if (pushStat !== Status.Success) {
        console.error(`Failed to push: ${pushStat}`);
        return pushStat;
      }
      this.xferState.emit();

      const pullStat = await syncPull(syncParams, this.apply.bind(this));
      if (pullStat !== Status.Success && pullStat !== Status.NoChange) {
        console.error(`Failed to pull: ${pullStat}`);
        return pullStat;
      }
      this.xferState.emit();
    }
    return Status.Success;
  }

  public async wipe() {
    await this.disconnect();
    await this.store.wipe();
    this.clientState.emit();
    this.xferState.emit();
  }

  public import = async (
    file: File,
    options?: {
      onProgress?: (index: number, total: number, status: Status) => void;
    },
  ): Promise<Status> => {
    const { crypto, store } = this;
    const onProgress = options?.onProgress;
    const enclave = await store.seed.load();
    if (!enclave) return Status.MissingSeed;

    console.time("import: decoding file...");
    const bytes = await file.bytes();
    const [msgs, statDec] = await decodeFile(bytes, crypto, enclave);
    if (statDec !== Status.Success) return statDec;
    console.timeEnd("import: decoding file...");

    let processed = 0;
    while (processed < msgs.length) {
      let totalBytes = 0;
      let count = 0;
      let end = processed;
      for (
        let i = processed;
        i < msgs.length && count < 100 && totalBytes < 100 * 1024;
        i++
      ) {
        totalBytes += msgs[i].head.len;
        count++;
        end = i + 1;
      }
      const batch = msgs.slice(processed, end);
      console.time(`import: applying [${processed}, ${end}]`);
      const statsBatch = await this.apply(batch, {
        enqueueUpload: true,
        triggerUpload: false,
      });
      console.timeEnd(`import: applying [${processed}, ${end}]`);
      for (let i = 0; i < batch.length; i++) {
        const stat = statsBatch[i];
        if (stat !== Status.Success && stat !== Status.NoChange) {
          console.warn(
            `failed to import msg ${processed + i}: ${Status[stat]}`,
          );
        }
      }
      if (onProgress) {
        queueMicrotask(() => onProgress(end, msgs.length, Status.Success));
      }
      processed = end;
    }

    this.scheduleSync();

    // TODO: return the array of statuses for each import msg.
    return Status.Success;
  };

  private scheduleSync = async () => {
    this.syncTimeout = setTimeout(async () => {
      this.syncTimeout = null;
      try {
        console.info("Running scheduled sync");
        await this.sync();
      } catch (err) {
        console.error("Debounced sync failed:", err);
      }
    }, this.SYNC_DEBOUNCE_DELAY_MS);
  };

  public async export(filename: string) {
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
  public async link(host: IHostConnectionInfo<Handle>, connect = true) {
    this.store.hosts.add(host);
    this.clientState.emit();

    if (connect) {
      const row = await this.store.hosts.get(host.label);
      if (row) {
        this.connectToHost(row);
      }
    }
  }

  public async unlink(label: string) {
    await this.store.hosts.del(label);
    this.clientState.emit();
  }

  private connectToHost = async (
    host: IHostRow<Handle>,
    listen = true,
    sync = true,
  ) => {
    const { clock, connections, crypto, store, transport } = this;
    if (connections.has(host.label)) return;

    const enclave = await store.seed.load();
    if (!enclave) return;

    console.info(`Connecting to ${host.handle} (${host.label})`);
    const conn = new DiplomaticClientAPI(
      enclave,
      libsodiumCrypto,
      host,
      clock,
      transport(host),
      (meta) => store.hosts.set(host.label, meta),
    );
    await conn.register();

    if (listen) {
      await conn.listen(async (bytes: Uint8Array) => {
        const syncParams = { conn, store, enclave, host, crypto, clock };
        return handleNotif(bytes, syncParams, this.apply, this.scheduleSync);
      });
    }

    connections.set(host.label, conn);

    if (sync) {
      this.scheduleSync();
    }
  };

  // Manage active host connections.
  public async connect(listen = true, sync = true) {
    const { connectToHost, scheduleSync, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      await connectToHost(host, listen, false);
    }
    if (sync) {
      scheduleSync();
    }
  }

  public disconnect = async () => {
    this.connections.clear();
  };
}
