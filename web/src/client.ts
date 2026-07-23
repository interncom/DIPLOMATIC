// This is the web client for DIPLOMATIC.

import { encode } from "@msgpack/msgpack";

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
import { btob64 } from "./shared/binary";
import { err, ok, ValStat } from "./shared/valstat";
import { CoalesceTail, Debounced, defaultSyncDebounceMs } from "./coalesce";
import { sortByHlcDesc } from "./hlc";
import {
  defaultPeekProgressEvery,
  idleProgress,
  SyncProgressEvent,
} from "./progress";
import { saveBlob } from "./saveBlob";
import {
  defaultMaxPullBytes,
  defaultMaxPushBytes,
  deqDownloadsForHeadHashes,
  handleNotif,
  ISyncParams,
  syncPeek,
  syncPull,
  syncPush,
} from "./sync";
import {
  APLD_PENDING,
  IClient,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IHostRow,
  IMsgParts,
  IStateEmitter,
  isTerminalApplyFailure,
  IStore,
  IStoredMessage,
  IStoredMessageWrite,
} from "./types";

export class SyncClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();

  /**
   * Serializes exec so concurrent drainApplyQueue / apply do not interleave
   * markApplied (each job runs fully, in order).
   */
  private applyChain: Promise<unknown> = Promise.resolve();

  /**
   * Coalesces overlapping sync() (one in flight + trailing pass).
   */
  private syncRuns = new CoalesceTail<Status>();

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  /**
   * Soft byte budgets for push/pull request batching (see syncPush / syncPull).
   * Raise for large-payload apps (e.g. media libraries).
   */
  public maxPushBytes: number;
  public maxPullBytes: number;

  /**
   * Peek progress stride in heads (see `defaultPeekProgressEvery`).
   * Emits on head 1, every N heads, and the last head.
   */
  public peekProgressEvery = defaultPeekProgressEvery;

  /** Latest progress; part of xferState for snapshot + subscribe. */
  private lastProgress: SyncProgressEvent = idleProgress;

  /**
   * Debounced full sync after local writes (when not handing off via onScheduleSync).
   */
  private scheduledSync: Debounced;

  constructor(
    private clock: IClock,
    private state: IStateManager,
    private store: IStore<Handle>,
    private transport: (host: IHostConnectionInfo<Handle>) => ITransport,
    private crypto: ICrypto,
    // Client can be set to always force skew handling, to hide the pain.
    private forceSkewHandlingByDefault = true,
    maxPushBytes = defaultMaxPushBytes,
    maxPullBytes = defaultMaxPullBytes,
    /**
     * When set (e.g. main-thread local writer next to a sync worker), called
     * instead of running sync on this client. Use to hand off push to the worker.
     */
    private onScheduleSync?: () => void,
  ) {
    this.maxPushBytes = maxPushBytes;
    this.maxPullBytes = maxPullBytes;
    this.clientState = new StateEmitter(() => this.getClientState());
    this.xferState = new StateEmitter(() => this.getXferState());
    this.scheduledSync = new Debounced(defaultSyncDebounceMs, async () => {
      try {
        console.info("Running scheduled sync");
        await this.sync();
      } catch (err) {
        console.error("Debounced sync failed:", err);
      }
    });
  }

  /** Record phase progress and notify xferState listeners. */
  private emitProgress = (ev: SyncProgressEvent) => {
    this.lastProgress = ev;
    this.xferState.emit();
  };

  public async setSeed(seed: MasterSeed) {
    await this.store.seed.save(seed);
    this.clientState.emit();
  }

  private async getClientState(): Promise<IDiplomaticClientState> {
    const { store, connections } = this;
    const enclave = await store.seed.load();
    const hosts = await store.hosts.list();

    // Use the per-connection isConnected() which respects listener state
    // (updated immediately via onConnect/onDisconnect callbacks).
    let connected = false;
    for (const conn of connections.values()) {
      if (conn.isConnected()) {
        connected = true;
        break;
      }
    }

    return {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected,
    };
  }

  private async getXferState(): Promise<IDiplomaticClientXferState> {
    const { uploads, downloads } = this.store;
    const numUploads = await uploads.count();
    const numDownloads = await downloads.count();
    return {
      numDownloads,
      numUploads,
      progress: this.lastProgress,
    };
  }

  /**
   * Persist msgs (APLD_PENDING), exec into app state, then optionally enq upload.
   *
   * Order (crash-safe):
   * 1) durable archive  2) exec + APLD_APPLIED/APLD_ERROR  3) upload queue
   * Exec is where the app validates the msg; only successes are pushed.
   * Crash between 1–2 → drainApplyQueue / exec stage recovers.
   */
  private apply = async (
    parts: IMsgParts[],
    options: { enqueueUpload: boolean; triggerUpload: boolean } = {
      enqueueUpload: true,
      triggerUpload: true,
    },
  ): Promise<Status[]> => {
    const hashes: Hash[] = [];
    const storables: { key: Hash; data: IStoredMessageWrite }[] = [];

    for (const { head, body } of parts) {
      const enc = new Encoder();
      enc.writeStruct(messageHeadCodec, head);
      const headEnc = enc.result();
      const hash = await this.crypto.blake3(headEnc);
      const data: IStoredMessageWrite = {
        eid: head.eid,
        body,
        apld: APLD_PENDING,
      };
      if (head.off !== 0) data.off = head.off;
      if (head.ctr !== 0) data.ctr = head.ctr;
      hashes.push(hash);
      storables.push({ key: hash, data });
    }

    await this.store.messages.add(storables);

    // Import / local write: drop any pending downloads for these heads so a
    // later sync does not re-PULL bags we already have in the archive.
    await deqDownloadsForHeadHashes(this.store, hashes, this.crypto);

    const stats = await this.applyHashes(hashes);

    // Upload only after successful (or no-op) exec for each hash.
    if (options.enqueueUpload) {
      const toUpload: Hash[] = [];
      for (let i = 0; i < hashes.length; i++) {
        const st = stats[i];
        if (st === Status.Success || st === Status.NoChange) {
          toUpload.push(hashes[i]);
        }
      }
      if (toUpload.length > 0) {
        const hosts = await this.store.hosts.list();
        for (const host of hosts) {
          await this.store.uploads.enq(host.label, toUpload);
        }
        this.xferState.emit();
      }
    }
    // Peer (worker) or local debounced sync drains the upload queue.
    if (options.triggerUpload) {
      this.scheduleSync();
    }

    return stats;
  };

  private enqueueApplyJob<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.applyChain.then(fn, fn);
    this.applyChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Apply archived msgs that are still unapplied (crash recovery).
   * Call after open / connect so a crash between store and apply is healed.
   */
  public drainApplyQueue(): Promise<Status[]> {
    return this.enqueueApplyJob(() => this.doDrainApplyQueue());
  }

  private async doDrainApplyQueue(): Promise<Status[]> {
    const pending = await this.store.messages.list(APLD_PENDING);
    if (pending.length < 1) {
      return [];
    }
    // Newest HLC first: final ent state appears early; obsolete ops still
    // no-op in EntDB. (IDB list order by apld index is not HLC order.)
    const ordered = sortByHlcDesc(pending, (m) => m.head);
    return this.applyStored(ordered);
  }

  /** Apply specific archive keys via IStateManager and mark applied. */
  private applyHashes = (hashes: Hash[]): Promise<Status[]> => {
    return this.enqueueApplyJob(async () => {
      const loaded: IStoredMessage[] = [];
      for (const h of hashes) {
        const m = await this.store.messages.get(h);
        if (m) loaded.push(m);
      }
      const applied = await this.applyStored(loaded);
      const byHash = new Map<string, Status>();
      for (let i = 0; i < loaded.length; i++) {
        byHash.set(
          btob64(loaded[i].hash),
          applied[i] ?? Status.InternalError,
        );
      }
      return hashes.map((h) => byHash.get(btob64(h)) ?? Status.NotFound);
    });
  };

  /**
   * Apply a batch of archived msgs via IStateManager and mark outcomes.
   * Success/NoChange → APLD_APPLIED; terminal failures → APLD_ERROR;
   * transient stay APLD_PENDING.
   *
   * TODO: may need to chunk large batches (memory / IDB / UI). Also test edge
   * cases: state.apply returning stats.length !== msgs.length (short/long
   * array, holes) — mark paths currently index stats[i] against stored[i]
   * without validating length alignment.
   */
  private async applyStored(stored: IStoredMessage[]): Promise<Status[]> {
    if (stored.length < 1) {
      return [];
    }
    const msgs: IMessage[] = stored.map((m) => ({
      ...m.head,
      bod: m.body,
    }));
    const stats = await this.state.apply(msgs);
    const done: Hash[] = [];
    const failed: { key: Hash; err: Status }[] = [];
    for (let i = 0; i < stored.length; i++) {
      const st = stats[i];
      if (st === Status.Success || st === Status.NoChange) {
        done.push(stored[i].hash);
      } else if (st !== undefined && isTerminalApplyFailure(st)) {
        failed.push({ key: stored[i].hash, err: st });
      }
    }
    if (done.length > 0) {
      await this.store.messages.markApplied(done);
    }
    if (failed.length > 0) {
      await this.store.messages.markFailed(failed);
    }
    return stats;
  }

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

  /**
   * Catch up: exec pending → per host peek → push → pull‖open → exec.
   * Overlapping sync() coalesce (+ trailing if demand mid-flight).
   */
  public sync(): Promise<Status> {
    return this.syncRuns.run(() => this.doSync());
  }

  private async doSync(): Promise<Status> {
    const { connections, crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return Status.MissingSeed;
    }

    // Unapplied archive (crash / prior open) before talking to hosts.
    await this.drainApplyQueue();

    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) continue;

      const syncParams: ISyncParams<Handle> = {
        conn,
        store,
        enclave,
        host,
        crypto,
        maxPushBytes: this.maxPushBytes,
        maxPullBytes: this.maxPullBytes,
        onProgress: this.emitProgress,
        peekProgressEvery: this.peekProgressEvery,
      };

      const peekStat = await syncPeek(syncParams);
      if (peekStat !== Status.Success) {
        console.error(`Failed to peek: ${peekStat}`);
        return peekStat;
      }
      this.xferState.emit();

      // Push before pull: local redundancy first.
      const pushStat = await syncPush(syncParams);
      if (pushStat !== Status.Success) {
        console.error(`Failed to push: ${pushStat}`);
        return pushStat;
      }
      this.xferState.emit();

      // Depth-1: next pull ‖ open/exec of current pull batch.
      const pullStat = await syncPull(syncParams, async () => {
        await this.drainApplyQueue();
      });
      if (pullStat !== Status.Success && pullStat !== Status.NoChange) {
        console.error(`Failed to pull: ${pullStat}`);
        return pullStat;
      }
      this.xferState.emit();
    }

    this.emitProgress({ phase: "idle" });
    return Status.Success;
  }

  public async wipe() {
    // Stop further scheduled work and tear down push listeners first.
    this.scheduledSync.cancel();
    await this.disconnect();
    // Let in-flight sync finish so it cannot repopulate after clear.
    await this.syncRuns.flush();
    await this.store.wipe();
    await this.state.clear();
    this.lastProgress = idleProgress;
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
      this.emitProgress({
        phase: "import",
        done: end,
        total: msgs.length,
      });
      processed = end;
    }

    this.scheduleSync();
    this.emitProgress({ phase: "idle" });

    // TODO: return the array of statuses for each import msg.
    return Status.Success;
  };

  /**
   * After local exec + upload enqueue: hand off to worker peer or debounce sync.
   */
  private scheduleSync = () => {
    if (this.onScheduleSync) {
      // Caller owns debounce (e.g. WorkerClient scheduledSync).
      this.onScheduleSync();
      return;
    }
    this.scheduledSync.schedule();
  };

  /** Encode the local message archive; used by worker path (main saves file). */
  public async exportBytes(): Promise<ValStat<Uint8Array>> {
    const { crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) return err(Status.MissingSeed);

    const msgs = await store.messages.list();
    return encodeFile("export", 0, msgs, crypto, enclave);
  }

  public async export(filename: string) {
    const [bytes, stat] = await this.exportBytes();
    if (stat !== Status.Success) return stat;
    if (!bytes) return Status.InternalError;

    const blob = new Blob([bytes.slice()]);
    saveBlob(blob, filename);
    return Status.Success;
  }

  // Manage stored host connections.
  public async link(host: IHostConnectionInfo<Handle>, connect = true) {
    await this.store.hosts.add(host);
    this.clientState.emit();

    if (connect) {
      const row = await this.store.hosts.get(host.label);
      if (row) {
        await this.connectToHost(row);
      }
    }
  }

  public async unlink(label: string) {
    await this.store.hosts.del(label);
    this.clientState.emit();
  }

  public async hosts(): Promise<IHostRow<Handle>[]> {
    return Array.from(await this.store.hosts.list());
  }

  private connectToHost = async (
    host: IHostRow<Handle>,
    listen = true,
    sync = true,
  ) => {
    const { clock, connections, crypto, store, transport } = this;

    const existing = connections.get(host.label);
    if (existing) {
      if (existing.isConnected()) {
        return;
      }
      // Connection exists but is dead (common after iOS backgrounding).
      // Clean it up so we can establish a fresh listener.
      try {
        existing.closeListener();
      } catch {
        // ignore
      }
      connections.delete(host.label);
    }

    const enclave = await store.seed.load();
    if (!enclave) return;

    console.info(`Connecting to ${host.handle} (${host.label})`);
    const conn = new DiplomaticClientAPI(
      enclave,
      crypto,
      host,
      clock,
      transport(host),
      (meta) => store.hosts.set(host.label, meta),
    );
    await conn.register();

    if (listen) {
      await conn.listen(
        async (bytes: Uint8Array) => {
          const syncParams: ISyncParams<Handle> = {
            conn,
            store,
            enclave,
            host,
            crypto,
            maxPushBytes: this.maxPushBytes,
            maxPullBytes: this.maxPullBytes,
            onProgress: this.emitProgress,
            peekProgressEvery: this.peekProgressEvery,
          };
          return handleNotif(bytes, syncParams, this.scheduleSync);
        },
        () => this.clientState.emit(), // onDisconnect
        () => this.clientState.emit(), // onConnect
      );
    }

    connections.set(host.label, conn);
    this.clientState.emit();

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
    // Heal archive → application state before listeners / network.
    await this.drainApplyQueue();
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      await connectToHost(host, listen, false);
    }
    if (sync) {
      scheduleSync();
    }
  }

  public disconnect = async () => {
    for (const conn of this.connections.values()) {
      try {
        conn.closeListener();
      } catch {
        // ignore teardown errors
      }
    }
    this.connections.clear();
    this.clientState.emit();
  };
}
