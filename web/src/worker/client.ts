// Main-thread façade over an app-owned sync worker.
//
// - Local msg create/apply (UI): main thread, shared message IDB + IStateManager
//   (e.g. EntDB) for fast UI. Upload queue is shared; push is handed to worker.
// - Network sync (peek/push/pull/notif): worker writes EntDB in-place and posts
//   dirty/wiped signals so main re-reads shared IDB (no bulk msg transfer).
//
// The app must construct the Worker (bundler-aware).

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
  clientStateFromUnknown,
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
 * Options for attaching to an app-owned sync Worker.
 *
 * Provide a live `Worker` — the library never constructs one. See
 * `openDiplomaticClient` for bundler/CDN instantiation recipes.
 *
 * Handshake is race-safe: the worker posts unsolicited `{ kind: "ready" }`, but
 * connect also probes with `ping`. Early construction (module scope) is fine even
 * if `ready` fired before `onmessage` was set — the ping still succeeds once the
 * worker has finished init (cmds are held until then on the worker side).
 *
 * After the ready barrier, connect hydrates `clientState` / `xferState` from the
 * shared main-thread store (and recovers via getClientState/getXferState if the
 * unsolicited events were dropped). Without that, the façade defaults to
 * `hasSeed: false` and apps flash the unauthenticated UI until a later event.
 */
export type WorkerClientOptions = {
  /** Already-constructed module Worker running `@interncom/diplomatic/worker`. */
  worker: Worker;
  /**
   * Max wait for handshake (`ready` event or probe ping; default 15s).
   * Failures throw; no fallback.
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
  private worker: Worker;
  private state: IStateManager;
  /** Shared protocol store (main connection). */
  private store: IStore<URL>;
  /** Main-thread writer: msg archive + local apply for fast UI. */
  private local: SyncClient<URL>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((e: Error) => void) | undefined;
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
    worker: Worker,
    state: IStateManager,
    store: IStore<URL>,
    clock: IClock,
    syncDebounceMs: number,
  ) {
    this.worker = worker;
    this.state = state;
    this.store = store;
    this.clientState = new StateEmitter(async () => this.cachedClientState);
    this.xferState = new StateEmitter(async () => this.cachedXferState);
    this.scheduledSync = new Debounced(syncDebounceMs, async () => {
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

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.worker.onmessage = (ev: MessageEvent<unknown>) => {
      this.onMessage(ev.data);
    };
    this.worker.onerror = (ev) => {
      console.error(`${logPrefix} worker error`, ev);
      this.failReady(new Error(`${logPrefix} worker failed to load`));
    };
    this.worker.onmessageerror = () => {
      this.failReady(new Error(`${logPrefix} worker message error`));
    };
  }

  private failReady(err: Error) {
    const rej = this.rejectReady;
    this.rejectReady = undefined;
    this.resolveReady = undefined;
    if (rej) {
      rej(err);
    }
  }

  /**
   * Run any pending debounced worker sync now and await it.
   * Useful in tests (with real debounce) or after a burst of local writes.
   */
  async flushScheduledSync(): Promise<void> {
    await this.scheduledSync.flush();
  }

  /**
   * Attach to an app-provided Worker. `store` is the shared protocol IDB (main
   * connection) used for local msg writes; worker opens its own connection.
   * Throws if the worker never becomes ready — does not fall back to main thread.
   *
   * Handshake: wait for unsolicited `ready` **or** a successful probe `ping`.
   * The probe covers the common case where the app started the Worker early and
   * `ready` was dropped before this thread set `onmessage`.
   *
   * Then hydrate client/xfer state from the shared store (and RPC) so
   * `clientState.get()` is correct before connect returns — unsolicited
   * `clientState` events are often lost when the Worker starts before
   * `onmessage` is attached.
   */
  static async connect(
    state: IStateManager,
    store: IStore<URL>,
    opts: WorkerClientOptions,
  ): Promise<WorkerClient> {
    const clock = opts.clock ?? new Clock();
    const debounce = opts.syncDebounceMs ?? defaultSyncDebounceMs;
    const client = new WorkerClient(opts.worker, state, store, clock, debounce);
    const timeoutMs = opts.readyTimeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Probe immediately after attaching the listener. Worker holds cmds until
      // init completes, so this also works while the worker is still booting.
      const probe = client.probeReady();
      await Promise.race([
        client.ready,
        probe,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `${logPrefix} worker ready timeout after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // If the unsolicited ready won the race, still surface probe failures
      // (e.g. broken postMessage) rather than returning a half-dead client.
      // Probe resolves when pong arrives; if ready already marked us live, the
      // pending pong is harmless.
      void probe.catch(() => {
        // Terminated / timed out paths reject pending; ignore after race.
      });
      // Seed/host live in shared IDB — correct hasSeed even if worker events
      // were dropped. Then RPC for authoritative connected/xfer (also recovers
      // missed unsolicited pushes).
      await client.hydrateStateFromStore(store);
      await client.pullRemoteState();
    } catch (e) {
      client.terminate();
      throw e;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    return client;
  }

  /**
   * Snapshot seed/host/queues from the shared main-thread store.
   * `connected` stays false until the worker reports otherwise.
   */
  private async hydrateStateFromStore(store: IStore<URL>): Promise<void> {
    const enclave = await store.seed.load();
    const hosts = await store.hosts.list();
    this.cachedClientState = {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected: false,
    };
    const numUploads = await store.uploads.count();
    const numDownloads = await store.downloads.count();
    this.cachedXferState = {
      numUploads,
      numDownloads,
      progress: idleProgress,
    };
  }

  /**
   * Request current client/xfer state from the worker. Recovers when unsolicited
   * `clientState` / `xferState` events fired before `onmessage` was set.
   */
  private async pullRemoteState(): Promise<void> {
    const clientRaw = await this.request({
      id: this.allocId(),
      op: "getClientState",
    });
    const clientState = clientStateFromUnknown(clientRaw);
    if (clientState !== undefined) {
      this.cachedClientState = clientState;
    }
    const xferRaw = await this.request({
      id: this.allocId(),
      op: "getXferState",
    });
    const xferState = xferStateFromUnknown(xferRaw);
    if (xferState !== undefined) {
      this.cachedXferState = xferState;
    }
  }

  /** Resolve the ready barrier (idempotent). */
  private markReady() {
    const done = this.resolveReady;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    if (done) done();
  }

  /**
   * Active handshake: post ping without waiting for the ready event.
   * On pong, mark ready so connect can proceed even if `ready` was missed.
   */
  private probeReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.allocId();
      this.pending.set(id, {
        resolve: (v) => {
          if (v === "pong") {
            this.markReady();
            resolve();
            return;
          }
          reject(new Error(`${logPrefix} worker probe ping failed`));
        },
        reject,
      });
      this.worker.postMessage({ id, op: "ping" } satisfies WorkerCmd);
    });
  }

  /** Lightweight RPC check after connect. */
  async ping(): Promise<void> {
    await this.ready;
    const result = await this.request({ id: this.allocId(), op: "ping" });
    if (result !== "pong") {
      throw new Error(`${logPrefix} worker ping failed`);
    }
  }

  /** Terminate the worker (drops protocol DB connection in that thread). */
  terminate() {
    this.scheduledSync.cancel();
    this.worker.terminate();
    for (const [, p] of this.pending) {
      p.reject(new Error(`${logPrefix} worker terminated`));
    }
    this.pending.clear();
  }

  private onMessage(data: unknown) {
    if (!isWorkerEvent(data)) {
      return;
    }
    const msg: WorkerEvent = data;

    switch (msg.kind) {
      case "ready": {
        this.markReady();
        return;
      }
      case "initError": {
        this.failReady(
          new Error(`${logPrefix} worker init failed: ${msg.message}`),
        );
        return;
      }
      case "clientState": {
        this.cachedClientState = msg.state;
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
    return new Promise((resolve, reject) => {
      this.pending.set(cmd.id, { resolve, reject });
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(cmd, transfer);
      } else {
        this.worker.postMessage(cmd);
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

  async setSeed(enclave: Enclave, opts?: SetSeedOpts): Promise<void> {
    await this.ready;
    // Shared IDB (if persist) + worker enclave (IPC handoff owned by Enclave).
    await this.local.setSeed(enclave, opts);
    this.cachedClientState = {
      ...this.cachedClientState,
      hasSeed: true,
    };
    this.clientState.emit();
    // Enclave posts setSeed + transfers seed; we only wait for the reply.
    const id = this.allocId();
    await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        enclave.postSetSeedToWorker(this.worker, {
          id,
          persist: opts?.persist,
        });
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async link(
    host: IHostConnectionInfo<URL>,
    connect = true,
  ): Promise<void> {
    await this.ready;
    // Hosts live in shared IDB; worker owns network registration.
    await this.local.link(host, false);
    await this.request({
      id: this.allocId(),
      op: "link",
      host: this.serializeHost(host),
      connect,
    });
  }

  async unlink(label: string): Promise<void> {
    await this.ready;
    await this.local.unlink(label);
    await this.request({ id: this.allocId(), op: "unlink", label });
  }

  /** Hosts live in shared main IDB (same as local writer). */
  async hosts(): Promise<IHostRow<URL>[]> {
    await this.ready;
    return this.local.hosts();
  }

  async connect(listen = true, sync = true): Promise<void> {
    await this.ready;
    await this.request({
      id: this.allocId(),
      op: "connect",
      listen,
      sync,
    });
  }

  async disconnect(): Promise<void> {
    await this.ready;
    await this.request({ id: this.allocId(), op: "disconnect" });
  }

  /** Local UI write: archive + apply on main (cache notifies UI); sync via worker. */
  async insertRaw(content: SerializedContent): Promise<ValStat<IMessageHead>> {
    await this.ready;
    return this.local.insertRaw(content);
  }

  async updateRaw(
    prior: IEntRev,
    content: SerializedContent | undefined,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>> {
    await this.ready;
    return this.local.updateRaw(prior, content, force);
  }

  async insert<T = unknown>(
    op: IInsertParams<T>,
  ): Promise<ValStat<IMessageHead>> {
    await this.ready;
    return this.local.insert(op);
  }

  async update<T = unknown>(
    op: IUpdateParams<T>,
  ): Promise<ValStat<IMessageHead>> {
    await this.ready;
    return this.local.update(op);
  }

  async delete(op: IDeleteParams): Promise<ValStat<IMessageHead>> {
    await this.ready;
    return this.local.delete(op);
  }

  async genEID(id?: Uint8Array): Promise<ValStat<EntityID>> {
    await this.ready;
    return this.local.genEID(id);
  }

  async sync(): Promise<Status> {
    await this.ready;
    return this.requestStatus({ id: this.allocId(), op: "sync" });
  }

  async rebuild(options?: { checkHost?: boolean }): Promise<Status> {
    await this.ready;
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
    await this.ready;
    return this.local.listMsgs(opts);
  }

  async countMsgs(apld?: ApldState): Promise<number> {
    await this.ready;
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
    await this.ready;
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
    await this.ready;
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
    await this.ready;
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
    await this.ready;
    // Main first: shared IDB tables + seed.wipe (largeBlob overwrite if wired).
    await this.local.wipe(opts);
    // Worker: network teardown + its store/enclave + EntDB connection.
    await this.request({
      id: this.allocId(),
      op: "wipe",
      msgs: opts?.msgs,
      ents: opts?.ents,
      meta: opts?.meta,
      seed: opts?.seed,
    });
    await this.hydrateStateFromStore(this.store);
    this.clientState.emit();
    this.xferState.emit();
  }

  async import(file: File): Promise<Status> {
    await this.ready;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.requestStatus(
      { id: this.allocId(), op: "import", bytes },
      [bytes.buffer],
    );
  }

  async export(filename: string, _extension?: string): Promise<Status> {
    await this.ready;
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
