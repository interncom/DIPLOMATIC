// Main-thread façade over an Enclave-spawned sync worker.
//
// - Local msg create/apply (UI): main thread, shared message IDB + IStateManager
//   (e.g. EntDB) for fast UI. Upload queue is shared; push is handed to worker.
// - Network sync (peek/push/pull/notif): worker writes EntDB in-place and posts
//   dirty/wiped signals so main re-reads shared IDB (no bulk msg transfer).
//
// No worker until setSeed → Enclave.spawnSyncWorker (only spawn path).
// Session hasSeed/hasHost are the main store; the worker only reports connected.

import { SyncClient } from "../client";
import { Debounced, defaultSyncDebounceMs } from "../coalesce";
import crypto from "../crypto";
import { StateEmitter } from "../events";
import { idleProgress } from "../progress";
import { saveBlob } from "../saveBlob";
import { Clock, IClock } from "../shared/clock";
import { Status } from "../shared/consts";
import type { Enclave } from "../shared/crypto/enclave";
import type {
  EntityID,
  Hash,
  IDeleteParams,
  IEntRev,
  IHostConnectionInfo,
  IInsertParams,
  IMessageHead,
  IStateManager,
  IUpdateParams,
  SerializedContent,
} from "../shared/types";
import { err, ok, type ValStat } from "../shared/valstat";
import type {
  ApldState,
  IClient,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IHostRow,
  IStateEmitter,
  IStore,
  IStoredMessage,
  ListMsgsOpts,
  ReconcileOpts,
  ReconcileReport,
  SetSeedOpts,
  WipeOpts,
} from "../types";
import {
  isWorkerEvent,
  SerializedHost,
  statusFromUnknown,
  WorkerCmd,
  WorkerEvent,
  xferStateFromUnknown,
} from "./protocol";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

/**
 * Options for the worker-mode façade.
 * Prefer {@link openDiplomaticClient} with `worker: true`.
 * The sync Worker is created only inside {@link WorkerClient.setSeed}
 * via {@link Enclave.spawnSyncWorker}.
 */
export type WorkerClientOptions = {
  /**
   * Max wait for Enclave.spawnSyncWorker handshake (setSeed reply; default 15s).
   */
  readyTimeoutMs?: number;
  clock?: IClock;
  /**
   * Debounce local write → worker `sync` (default {@link defaultSyncDebounceMs}).
   * Use `0` in tests for immediate handoff (no timers).
   */
  syncDebounceMs?: number;
};

const logPrefix = "[DIPLOMATIC]";

export class WorkerClient implements IClient<URL> {
  /** Set only by setSeed → Enclave.spawnSyncWorker. */
  private worker: Worker | undefined;
  private state: IStateManager;
  /** Shared protocol store (main connection). */
  private store: IStore<URL>;
  /** Main-thread writer: msg archive + local apply for fast UI. */
  private local: SyncClient<URL>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Max wait for setSeed worker handshake. */
  private readyTimeoutMs: number;
  /** Debounced local write → worker upload/sync. */
  private scheduledSync: Debounced;

  private cachedClientState: IDiplomaticClientState = {
    hasSeed: false,
    hasHost: false,
    connected: false,
  };
  private cachedXferState: IDiplomaticClientXferState = {
    numUploads: 0,
    numDownloads: 0,
    progress: idleProgress,
  };

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  private constructor(
    state: IStateManager,
    store: IStore<URL>,
    clock: IClock,
    syncDebounceMs: number,
    readyTimeoutMs: number,
  ) {
    this.state = state;
    this.store = store;
    this.readyTimeoutMs = readyTimeoutMs;
    this.clientState = new StateEmitter(async () => this.cachedClientState);
    this.xferState = new StateEmitter(async () => this.cachedXferState);
    this.scheduledSync = new Debounced(syncDebounceMs, async () => {
      if (!this.worker) return;
      try {
        await this.request({ id: this.allocId(), op: "sync" });
      } catch (e) {
        console.error(`${logPrefix} worker sync after local write failed`, e);
      }
    });

    // Local mutates write shared IDB and apply state on main; push/sync goes to worker.
    this.local = new SyncClient(
      clock,
      state,
      store,
      () => {
        throw new Error(
          `${logPrefix} local writer has no transport (use worker for network)`,
        );
      },
      crypto,
      true,
      undefined,
      undefined,
      () => {
        this.scheduledSync.schedule();
      },
    );

    // Local apply enqueues uploads on the shared store and emits local.xferState.
    // The UI listens to this façade; without forwarding, offline writes never
    // update pending counts (worker only posts xferState after successful
    // peek/push/pull, which never runs while disconnected).
    this.local.xferState.listen((state) => {
      this.cachedXferState = {
        numUploads: state.numUploads,
        numDownloads: state.numDownloads,
        // Keep worker-driven phase progress; local writer never runs network.
        progress: this.cachedXferState.progress,
      };
      this.xferState.emit();
    });
  }

  /** Wire handlers; terminate any previous worker. */
  private bindWorker(next: Worker) {
    const prev = this.worker;
    if (prev) {
      prev.onmessage = null;
      prev.onerror = null;
      prev.onmessageerror = null;
      try {
        prev.terminate();
      } catch {
        // ignore
      }
    }
    this.worker = next;
    next.onmessage = (ev: MessageEvent<unknown>) => {
      this.onMessage(ev.data);
    };
    next.onerror = (ev) => {
      console.error(`${logPrefix} worker error`, ev);
      this.failPending(new Error(`${logPrefix} worker failed to load`));
    };
    next.onmessageerror = () => {
      this.failPending(new Error(`${logPrefix} worker message error`));
    };
  }

  /** Reject all in-flight RPC (worker death / init failure). */
  private failPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Run any pending debounced worker sync now and await it.
   * Useful in tests (with real debounce) or after a burst of local writes.
   */
  async flushScheduledSync(): Promise<void> {
    await this.scheduledSync.flush();
  }

  /**
   * Open the worker-mode façade without spawning a Worker.
   * Shared store hydrates client/xfer state; network starts after setSeed.
   */
  static async open(
    state: IStateManager,
    store: IStore<URL>,
    opts: WorkerClientOptions = {},
  ): Promise<WorkerClient> {
    const clock = opts.clock ?? new Clock();
    const debounce = opts.syncDebounceMs ?? defaultSyncDebounceMs;
    const timeoutMs = opts.readyTimeoutMs ?? 15_000;
    const client = new WorkerClient(state, store, clock, debounce, timeoutMs);
    await client.hydrateStateFromStore(store);
    return client;
  }

  /**
   * Snapshot seed/host/queues from the shared main-thread store.
   * `connected` stays false until the worker reports otherwise.
   */
  private async hydrateStateFromStore(store: IStore<URL>): Promise<void> {
    await this.loadSession(false);
    const numUploads = await store.uploads.count();
    const numDownloads = await store.downloads.count();
    this.cachedXferState = {
      numUploads,
      numDownloads,
      progress: idleProgress,
    };
  }

  /** Seed + host from the local store. Worker never owns these. */
  private async loadSession(connected: boolean): Promise<void> {
    const enclave = await this.store.seed.load();
    const hosts = await this.store.hosts.list();
    this.cachedClientState = {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected,
    };
  }

  /** Queue depths + progress from the worker (after setSeed). */
  private async pullRemoteXfer(): Promise<void> {
    const xferRaw = await this.request({
      id: this.allocId(),
      op: "getXferState",
    });
    const xferState = xferStateFromUnknown(xferRaw);
    if (xferState !== undefined) {
      this.cachedXferState = xferState;
    }
  }

  private requireWorker(): Worker {
    if (!this.worker) {
      throw new Error(`${logPrefix} no sync worker; call setSeed first`);
    }
    return this.worker;
  }

  /** Lightweight RPC check after setSeed. */
  async ping(): Promise<void> {
    const result = await this.request({ id: this.allocId(), op: "ping" });
    if (result !== "pong") {
      throw new Error(`${logPrefix} worker ping failed`);
    }
  }

  /** Terminate the worker if any (drops protocol DB connection in that thread). */
  terminate() {
    this.scheduledSync.cancel();
    const w = this.worker;
    this.worker = undefined;
    if (w) {
      try {
        w.terminate();
      } catch {
        // ignore
      }
    }
    this.failPending(new Error(`${logPrefix} worker terminated`));
  }

  private onMessage(data: unknown) {
    if (!isWorkerEvent(data)) {
      return;
    }
    const msg: WorkerEvent = data;

    switch (msg.kind) {
      case "ready": {
        // Init complete; setSeed (and other cmds) run after worker whenReady.
        return;
      }
      case "initError": {
        this.failPending(
          new Error(`${logPrefix} worker init failed: ${msg.message}`),
        );
        return;
      }
      case "clientState": {
        if (this.cachedClientState.connected === msg.connected) {
          return;
        }
        this.cachedClientState = {
          ...this.cachedClientState,
          connected: msg.connected,
        };
        this.clientState.emit();
        return;
      }
      case "xferState": {
        this.cachedXferState = msg.state;
        this.xferState.emit();
        return;
      }
      case "dirty": {
        // Worker wrote durable EntDB; cache pulls those eids, notifies types.
        void this.state.refresh(msg.eids.map(entityIDFromBytes));
        return;
      }
      case "wiped": {
        // Worker cleared stores; refresh subscribers (clear is idempotent on IDB).
        void this.state.clear();
        return;
      }
      case "reply": {
        const p = this.pending.get(msg.id);
        if (!p) {
          return;
        }
        this.pending.delete(msg.id);
        if (msg.ok) {
          p.resolve(msg.result);
        } else {
          p.reject(new WorkerReplyError(msg.status));
        }
        return;
      }
      default: {
        return;
      }
    }
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private request(
    cmd: WorkerCmd,
    transfer?: Transferable[],
  ): Promise<unknown> {
    const worker = this.requireWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(cmd.id, { resolve, reject });
      if (transfer && transfer.length > 0) {
        worker.postMessage(cmd, transfer);
      } else {
        worker.postMessage(cmd);
      }
    });
  }

  private async requestStatus(
    cmd: WorkerCmd,
    transfer?: Transferable[],
  ): Promise<Status> {
    try {
      const result = await this.request(cmd, transfer);
      const st = statusFromUnknown(result);
      if (st !== undefined) {
        return st;
      }
      return Status.Success;
    } catch (e) {
      if (e instanceof WorkerReplyError) {
        return e.status;
      }
      return Status.InternalError;
    }
  }

  private serializeHost(
    host: IHostConnectionInfo<URL>,
  ): SerializedHost {
    return {
      handle: host.handle.href,
      label: host.label,
      idx: host.idx ?? 0,
    };
  }

  /**
   * Persist seed on main, then Enclave.spawnSyncWorker (only worker spawn path).
   * Awaits the worker's setSeed reply (worker boots, then applies seed).
   */
  async setSeed(enclave: Enclave, opts?: SetSeedOpts): Promise<void> {
    // Shared IDB (if persist); worker gets seed only via Enclave factory.
    await this.local.setSeed(enclave, opts);
    // New worker is not connected; hasSeed/hasHost come from the local store.
    await this.loadSession(false);
    this.clientState.emit();

    const id = this.allocId();
    const timeoutMs = this.readyTimeoutMs;
    await new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const settle = (fn: () => void) => {
        if (timer !== undefined) clearTimeout(timer);
        fn();
      };
      this.pending.set(id, {
        resolve: (v) => settle(() => resolve(v)),
        reject: (e) => settle(() => reject(e)),
      });
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${logPrefix} setSeed worker timeout after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      try {
        const seeded = enclave.spawnSyncWorker({
          id,
          persist: opts?.persist,
        });
        this.bindWorker(seeded);
      } catch (e) {
        this.pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    try {
      await this.pullRemoteXfer();
    } catch {
      // Offline / mock workers may not implement getXferState.
    }
  }

  async link(
    host: IHostConnectionInfo<URL>,
    connect = true,
  ): Promise<void> {
    // Hosts live in shared IDB; worker owns network registration.
    await this.local.link(host, false);
    await this.loadSession(this.cachedClientState.connected);
    this.clientState.emit();
    await this.request({
      id: this.allocId(),
      op: "link",
      host: this.serializeHost(host),
      connect,
    });
  }

  async unlink(label: string): Promise<void> {
    await this.local.unlink(label);
    await this.loadSession(this.cachedClientState.connected);
    this.clientState.emit();
    if (!this.worker) return;
    await this.request({ id: this.allocId(), op: "unlink", label });
  }

  /** Hosts live in shared main IDB (same as local writer). */
  async hosts(): Promise<IHostRow<URL>[]> {
    return this.local.hosts();
  }

  async connect(listen = true, sync = true): Promise<void> {
    // No worker until setSeed — same as SyncClient.connect with no enclave.
    if (!this.worker) return;
    await this.request({
      id: this.allocId(),
      op: "connect",
      listen,
      sync,
    });
  }

  async disconnect(): Promise<void> {
    if (!this.worker) return;
    await this.request({ id: this.allocId(), op: "disconnect" });
  }

  /** Local UI write on main (cache notifies in apply's sync prefix); sync via worker. */
  async insertRaw(
    content: SerializedContent,
    typ?: string,
  ): Promise<ValStat<IMessageHead>> {
    return this.local.insertRaw(content, typ);
  }

  async updateRaw(
    prior: IEntRev,
    content: SerializedContent | undefined,
    force?: boolean,
    typ?: string,
  ): Promise<ValStat<IMessageHead>> {
    return this.local.updateRaw(prior, content, force, typ);
  }

  async insert<T = unknown>(
    op: IInsertParams<T>,
  ): Promise<ValStat<IMessageHead>> {
    return this.local.insert(op);
  }

  async update<T = unknown>(
    op: IUpdateParams<T>,
  ): Promise<ValStat<IMessageHead>> {
    return this.local.update(op);
  }

  async delete(op: IDeleteParams): Promise<ValStat<IMessageHead>> {
    return this.local.delete(op);
  }

  async genEID(id?: Uint8Array): Promise<ValStat<EntityID>> {
    return this.local.genEID(id);
  }

  async sync(): Promise<Status> {
    if (!this.worker) return Status.Success;
    return this.requestStatus({ id: this.allocId(), op: "sync" });
  }

  async rebuild(options?: { checkHost?: boolean }): Promise<Status> {
    this.scheduledSync.cancel();
    await this.scheduledSync.flush();
    return this.requestStatus({
      id: this.allocId(),
      op: "rebuild",
      checkHost: options?.checkHost,
    });
  }

  /** Shared message IDB on main — no worker RPC. */
  async listMsgs(opts?: ListMsgsOpts): Promise<IStoredMessage[]> {
    return this.local.listMsgs(opts);
  }

  async countMsgs(apld?: ApldState): Promise<number> {
    return this.local.countMsgs(apld);
  }

  /**
   * Full host inventory on the worker (network + crypto off main).
   * Returns ephemeral msgcheck + bag counts (not persisted).
   */
  async reconcile(
    hostLabel: string,
    opts?: ReconcileOpts,
  ): Promise<ValStat<ReconcileReport>> {
    try {
      const result = await this.request({
        id: this.allocId(),
        op: "reconcile",
        hostLabel,
        pull: opts?.pull,
        push: opts?.push,
        sync: opts?.sync,
      });
      if (!isReconcileReport(result)) {
        return err(Status.InternalError);
      }
      return ok(result);
    } catch (e) {
      if (e instanceof WorkerReplyError && e.status !== Status.Success) {
        return err(e.status);
      }
      return err(Status.InternalError);
    }
  }

  /** Archive checksum via worker (listKeys + sort + blake3 off main). */
  async msgcheck(): Promise<Hash> {
    const result = await this.request({
      id: this.allocId(),
      op: "msgcheck",
    });
    if (!(result instanceof Uint8Array)) {
      throw new Error(`${logPrefix} msgcheck: expected Uint8Array`);
    }
    return result as Hash;
  }

  /**
   * EntDB frontier checksum off main (eid+upd+ctr). Not on IClient —
   * SyncClient has no EntDB; use entDB.checksum(crypto) on the main path.
   */
  async entcheck(): Promise<Hash> {
    const result = await this.request({
      id: this.allocId(),
      op: "entcheck",
    });
    if (!(result instanceof Uint8Array)) {
      throw new Error(`${logPrefix} entcheck: expected Uint8Array`);
    }
    return result as Hash;
  }

  async wipe(opts?: WipeOpts): Promise<void> {
    // Main first: shared IDB tables + seed.wipe (largeBlob overwrite if wired).
    await this.local.wipe(opts);
    if (this.worker) {
      // Worker: network teardown + its store/enclave + EntDB connection.
      await this.request({
        id: this.allocId(),
        op: "wipe",
        msgs: opts?.msgs,
        ents: opts?.ents,
        meta: opts?.meta,
        seed: opts?.seed,
      });
    }
    await this.hydrateStateFromStore(this.store);
    this.clientState.emit();
    this.xferState.emit();
  }

  async import(file: File): Promise<Status> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.requestStatus(
      { id: this.allocId(), op: "import", bytes },
      [bytes.buffer],
    );
  }

  async export(filename: string, _extension?: string): Promise<Status> {
    try {
      const result = await this.request({
        id: this.allocId(),
        op: "export",
      });
      if (!(result instanceof Uint8Array)) {
        return Status.InternalError;
      }
      const blob = new Blob([result.slice()]);
      saveBlob(blob, filename);
      return Status.Success;
    } catch (e) {
      if (e instanceof WorkerReplyError) {
        return e.status;
      }
      return Status.InternalError;
    }
  }
}

class WorkerReplyError extends Error {
  constructor(public status: Status) {
    super(`WorkerReplyError: ${Status[status]}`);
    this.name = "WorkerReplyError";
  }
}

function isReconcileReport(v: unknown): v is ReconcileReport {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.msgcheck instanceof Uint8Array &&
    o.msgcheck.length === 32 &&
    typeof o.numBags === "number" &&
    typeof o.numDupes === "number"
  );
}

function entityIDFromBytes(bytes: Uint8Array): EntityID {
  return bytes as EntityID;
}
