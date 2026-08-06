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
  IDeleteParams,
  IEntRev,
  IHostConnectionInfo,
  IInsertParams,
  IMessage,
  IMessageHead,
  IMsgEntBody,
  IStateManager,
  ITransport,
  IUpdateParams,
  MasterSeed,
} from "./shared/types";
import { btob64 } from "./shared/binary";
import { checksumSet } from "./shared/checksum";
import { revFromHead } from "./entdb/entdb";
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
  ApldState,
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
  ListMsgsOpts,
} from "./types";

export class SyncClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();

  /**
   * Serializes local mutates + exec so concurrent drainApplyQueue / apply do
   * not interleave markApplied (each job runs fully, in order).
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
   *
   * Serialized on applyChain (with local mutates).
   */
  private apply = (
    parts: IMsgParts[],
    options?: { enqueueUpload: boolean; triggerUpload: boolean },
  ): Promise<Status[]> => {
    return this.enqueueApplyJob(() => this.doApply(parts, options));
  };

  /**
   * Core apply without enqueue. Caller must already hold applyChain when
   * composing makeUpdate + apply in one job.
   */
  private async doApply(
    parts: IMsgParts[],
    options: { enqueueUpload: boolean; triggerUpload: boolean } = {
      enqueueUpload: true,
      triggerUpload: true,
    },
  ): Promise<Status[]> {
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

    const stats = await this.doApplyHashes(hashes);

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
  }

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
    const pending = await this.store.messages.list({ apld: APLD_PENDING });
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
    return this.enqueueApplyJob(() => this.doApplyHashes(hashes));
  };

  private async doApplyHashes(hashes: Hash[]): Promise<Status[]> {
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
  }

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
    const stats = await this.apply([{ head, body: bod }]);
    const st = stats[0];
    if (st !== Status.Success && st !== Status.NoChange) {
      return err<IMessageHead>(st ?? Status.InternalError);
    }
    return ok(head);
  }

  /**
   * Build the next update/delete msg from prior. Pure: no archive I/O.
   * Returns ClockOutOfSync if prior is in the future (caller handles force).
   */
  private async makeUpdate(
    prior: IEntRev,
    bod: EncodedMessage | undefined,
  ): Promise<ValStat<IMsgParts>> {
    const { clock, crypto } = this;
    const now = clock.now();
    if (prior.updatedAt.getTime() > now.getTime()) {
      return err(Status.ClockOutOfSync);
    }
    const ctr = prior.ctr + 1;
    const [head, statMsg] = await genUpsertHead({
      now,
      eid: prior.eid,
      ctr,
      bod,
      crypto,
    });
    if (statMsg !== Status.Success) {
      return err(statMsg);
    }
    return ok({ head, body: bod });
  }

  /**
   * Recover when prior's last-write time is in the future relative to this
   * clock. That means either:
   * a) another client's clock is skewed into the future, or
   * b) this client's clock is skewed into the past.
   *
   * We recover by deleting the skewed ent and (for a non-delete write)
   * replacing it. The delete must increment off so it overwrites the skewed
   * state, even if that places the delete into the future as well.
   * Replacement keeps the same id bytes with a new created-at of now.
   */
  private async updateWithSkew(
    prior: IEntRev,
    bod: EncodedMessage | undefined,
    force: boolean,
  ): Promise<ValStat<IMessageHead>> {
    if (force === false) {
      return err(Status.ClockOutOfSync);
    }
    const { clock, crypto } = this;
    const now = clock.now();
    const decEid = new Decoder(prior.eid);
    const [eidDec, statEid] = decEid.readStruct(eidCodec);
    if (statEid !== Status.Success) {
      return err(statEid);
    }
    // off must beat prior; may still be in the future relative to now.
    const priorOff = prior.updatedAt.getTime() - eidDec.ts.getTime();
    const delHead: IMessageHead = {
      eid: prior.eid,
      off: priorOff + 1,
      ctr: prior.ctr + 1,
      len: 0,
    };
    const statsDel = await this.apply([
      { head: delHead, body: undefined },
    ]);
    const statDel = statsDel[0];
    if (statDel !== Status.Success && statDel !== Status.NoChange) {
      return err(statDel ?? Status.InternalError);
    }
    if (bod === undefined) {
      // Caller was deleting; skew delete is the whole write.
      return ok(delHead);
    }
    // Replace: same id bytes, created-at = now, ctr 0.
    const [replEID, statReplEID] = makeEID({ id: eidDec.id, ts: now });
    if (statReplEID !== Status.Success) {
      return err(statReplEID);
    }
    const [repl, statRepl] = await genUpsertHead({
      now,
      eid: replEID,
      ctr: 0,
      bod,
      crypto,
    });
    if (statRepl !== Status.Success) {
      return err(statRepl);
    }
    const stats = await this.apply([{ head: repl, body: bod }]);
    const st = stats[0];
    if (st !== Status.Success && st !== Status.NoChange) {
      return err(st ?? Status.InternalError);
    }
    return ok(repl);
  }

  public async updateRaw(
    prior: IEntRev,
    bod: EncodedMessage | undefined,
    force = this.forceSkewHandlingByDefault,
  ): Promise<ValStat<IMessageHead>> {
    // prior was written "in the future" relative to this clock → skew path.
    if (prior.updatedAt.getTime() > this.clock.now().getTime()) {
      return this.updateWithSkew(prior, bod, force);
    }

    return this.enqueueApplyJob(async () => {
      // prior is the app's latest observed rev (from cache / revFromEntity).
      // Next ctr = prior.ctr + 1. Stale priors still produce a msg; LWW applies.
      const [parts, stMake] = await this.makeUpdate(prior, bod);
      if (stMake !== Status.Success) {
        return err<IMessageHead>(stMake);
      }
      const stats = await this.doApply([parts]);
      const st = stats[0];
      if (st !== Status.Success && st !== Status.NoChange) {
        return err<IMessageHead>(st ?? Status.InternalError);
      }
      return ok(parts.head);
    });
  }

  public async insert<T = unknown>(op: IInsertParams<T>) {
    const { body, type, gid, pid, tags } = op;
    const entBody: IMsgEntBody = { body, type, gid, pid, tags };
    const entBodyEnc = encode(entBody);
    return this.insertRaw(entBodyEnc);
  }

  public async update<T = unknown>(op: IUpdateParams<T>) {
    const { prior, body, type, gid, pid, tags, force } = op;
    const entBody: IMsgEntBody = { body, type, gid, pid, tags };
    const entBodyEnc = encode(entBody);
    return this.updateRaw(
      prior,
      entBodyEnc,
      force ?? this.forceSkewHandlingByDefault,
    );
  }

  /**
   * Delete by `{ prior }` (preferred) or `{ eid }` (archive lookup).
   * `force` defaults to true (skew recovery on delete).
   */
  public async delete(op: IDeleteParams) {
    const force = op.force ?? true;
    if ("prior" in op) {
      return this.updateRaw(op.prior, undefined, force);
    }
    const [prior, st] = await this.revFromArchive(op.eid);
    if (st !== Status.Success) {
      return err<IMessageHead>(st);
    }
    return this.updateRaw(prior, undefined, force);
  }

  /**
   * Latest rev for eid from the message archive.
   * If none, returns ctr -1 so the next write uses ctr 0.
   */
  private async revFromArchive(eid: EntityID): Promise<ValStat<IEntRev>> {
    const last = await this.store.messages.last(eid);
    if (last) {
      return revFromHead(last.head);
    }
    const dec = new Decoder(eid);
    const [parsed, st] = dec.readStruct(eidCodec);
    if (st !== Status.Success) {
      return err(st);
    }
    return ok({
      eid,
      ctr: -1,
      updatedAt: parsed.ts,
    });
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
        // Still publish queue depths (e.g. offline after local enqueue) and
        // clear any mid-phase progress so Sync UI is not stuck on "peek".
        this.emitProgress({ phase: "idle" });
        return peekStat;
      }
      this.xferState.emit();

      // Push before pull: local redundancy first.
      const pushStat = await syncPush(syncParams);
      if (pushStat !== Status.Success) {
        console.error(`Failed to push: ${pushStat}`);
        this.emitProgress({ phase: "idle" });
        return pushStat;
      }
      this.xferState.emit();

      // Depth-1: next pull ‖ open/exec of current pull batch.
      const pullStat = await syncPull(syncParams, async () => {
        await this.drainApplyQueue();
      });
      if (pullStat !== Status.Success && pullStat !== Status.NoChange) {
        console.error(`Failed to pull: ${pullStat}`);
        this.emitProgress({ phase: "idle" });
        return pullStat;
      }
      this.xferState.emit();
    }

    this.emitProgress({ phase: "idle" });
    return Status.Success;
  }

  /**
   * Rebuild application state from the local message archive.
   *
   * By default, inventories each linked host from seq 0 (full header list),
   * enqueues and pulls any bags missing from the archive, then clears EntDB
   * (or other app state) and re-executes every archived msg. Use after a
   * schema/applier change when derived ents diverge from the durable archive.
   *
   * Pass `{ checkHost: false }` to skip the host inventory (offline / local-only).
   * Does not wipe the message archive, seed, or hosts.
   */
  public async rebuild(
    options?: { checkHost?: boolean },
  ): Promise<Status> {
    // Wait out in-flight sync; cancel debounced work so it cannot interleave.
    this.scheduledSync.cancel();
    await this.syncRuns.flush();

    const checkHost = options?.checkHost ?? true;
    if (checkHost) {
      const st = await this.repull();
      if (st !== Status.Success) {
        return st;
      }
    }
    // Serialize clear + replay with local mutates / drain.
    return this.enqueueApplyJob(() => this.replay());
  }

  /**
   * Checksum of the local msg archive (set of head hashes).
   * listKeys → raw bytes → sort → blake3(concat); empty → blake3(∅).
   * Store key encoding is irrelevant; we always sort decoded (binary) hashes.
   */
  public async msgcheck(): Promise<Hash> {
    const keys = await this.store.messages.listKeys();
    return checksumSet(keys, this.crypto);
  }

  /**
   * List local archive rows (failed apply, pending drain, full dump).
   * Bodies included by default; pass `body: false` for lighter listings.
   */
  public listMsgs(opts?: ListMsgsOpts): Promise<IStoredMessage[]> {
    return this.store.messages.list(opts);
  }

  /** Count archive rows; optional apld filter. Prefer over list+length. */
  public countMsgs(apld?: ApldState): Promise<number> {
    return this.store.messages.count(apld);
  }

  /**
   * Peek each host from seq 0 and pull any bags not already in the archive.
   * Leaves open msgs as APLD_PENDING; does not exec (rebuild replays everything).
   */
  private async repull(): Promise<Status> {
    const { connections, crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return Status.MissingSeed;
    }

    const hosts = Array.from(await store.hosts.list());
    if (hosts.length < 1) {
      return Status.Success;
    }

    // Connect to any hosts that are known but not connected.
    for (const host of hosts) {
      const existing = connections.get(host.label);
      if (!existing || !existing.isConnected()) {
        // No listen/sync: inventory only; rebuild will replay after pull.
        await this.connectToHost(host, false, false);
      }
    }

    // Peek and pull from each host.
    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      // TODO: handle missing hosts better. If all were missing, would be NOP but still report success.
      if (!host) continue;

      // Full inventory: override lastSeq so peek returns every head.
      const syncParams: ISyncParams<Handle> = {
        conn,
        store,
        enclave,
        host: { ...host, lastSeq: 0 },
        crypto,
        maxPushBytes: this.maxPushBytes,
        maxPullBytes: this.maxPullBytes,
        onProgress: this.emitProgress,
        peekProgressEvery: this.peekProgressEvery,
      };

      const peekStat = await syncPeek(syncParams);
      if (peekStat !== Status.Success) {
        console.error(`rebuild: failed to peek: ${peekStat}`);
        this.emitProgress({ phase: "idle" });
        return peekStat;
      }
      this.xferState.emit();

      // Open only — no exec; replay applies the full archive after clear.
      const pullStat = await syncPull(syncParams);
      if (pullStat !== Status.Success && pullStat !== Status.NoChange) {
        console.error(`rebuild: failed to pull: ${pullStat}`);
        this.emitProgress({ phase: "idle" });
        return pullStat;
      }
      this.xferState.emit();
    }

    this.emitProgress({ phase: "idle" });
    return Status.Success;
  }

  /**
   * Clear app state and re-exec every archived msg (HLC newest-first batches).
   * Caller must hold applyChain.
   */
  private async replay(): Promise<Status> {
    const clearStat = await this.state.clear();
    if (clearStat !== Status.Success) {
      return clearStat;
    }

    // TODO: could message store just maintain these in sorted order so we don't have to sort manually?
    const all = await this.store.messages.list();
    const ordered = sortByHlcDesc(all, (m) => m.head);
    const total = ordered.length;
    if (total < 1) {
      this.emitProgress({ phase: "idle" });
      return Status.Success;
    }

    let processed = 0;
    while (processed < ordered.length) {
      let totalBytes = 0;
      let count = 0;
      let end = processed;
      for (
        let i = processed;
        i < ordered.length && count < 100 && totalBytes < 100 * 1024;
        i++
      ) {
        totalBytes += ordered[i].head.len;
        count++;
        end = i + 1;
      }
      const batch = ordered.slice(processed, end);
      await this.applyStored(batch);
      this.emitProgress({
        phase: "exec",
        done: end,
        total,
      });
      processed = end;
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
