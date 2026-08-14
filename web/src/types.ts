import type { SyncProgressEvent } from "./progress";
import { Status } from "./shared/consts";
import type { Enclave } from "./shared/crypto/enclave";
import type { EncodedMessage } from "./shared/message";
import type {
  EntityID,
  Hash,
  HostHandle,
  IDeleteParams,
  IEntRev,
  IHostConnectionInfo,
  IHostMetadata,
  IInsertParams,
  IMessageHead,
  IOp,
  IUpdateParams,
  SerializedContent,
} from "./shared/types";
import { ValStat } from "./shared/valstat";
import { ICrypto } from "./shared/types";

export interface IMsgParts {
  head: IMessageHead;
  body?: EncodedMessage;
}

/** Seed/host from the local store; `connected` from the sync worker (if any). */
export interface IDiplomaticClientState {
  hasSeed: boolean;
  hasHost: boolean;
  connected: boolean;
}

/**
 * Transfer / sync activity: queue depths + current phase progress.
 * Subscribe via `xferState.listen` / `useClientXferState`; snapshot with `get()`.
 */
export interface IDiplomaticClientXferState {
  numUploads: number;
  numDownloads: number;
  /** Latest sync/import phase tick; `{ phase: "idle" }` when not in flight. */
  progress: SyncProgressEvent;
}

export type Applier = (
  ops: IOp[],
) => Promise<{ stats: Status[]; types: Set<string>; eids: EntityID[] }>;

/** Options when installing a session {@link Enclave}. */
export type SetSeedOpts = {
  /**
   * When true, request durable storage **if the store supports a non-plaintext
   * durable form** (e.g. passkey largeBlob as IdentityBundle wire).
   * IDB holds the enclave in memory only — durable identity is PRF-sealed meta
   * via {@link IDBSeedStore.openPrfStore}, never plain seed.
   * Default false (session enclave only).
   *
   * Future: when PRF is unavailable, durable path is passphrase-sealed meta
   * (KDF + AEAD inside Enclave), not plain seed on disk.
   */
  persist?: boolean;
};

/**
 * Selective wipe for {@link IClient.wipe}.
 *
 * Default `client.wipe()` / `client.wipe({})` clears **everything except seed**:
 * msgs, ents, meta = true; seed = false.
 * That avoids passkey/largeBlob UV when the user only wants to clear app data.
 * Pass `{ seed: true }` to also clear identity (may prompt the authenticator).
 */
export type WipeOpts = {
  /** Message archive. Default true. */
  msgs?: boolean;
  /** Application EntDB / state manager. Default true. */
  ents?: boolean;
  /** Hosts + upload/download queues. Default true. */
  meta?: boolean;
  /**
   * Seed / identity ({@link ISeedStore.wipe}). Default **false**.
   * When true, passkey stores overwrite largeBlob (UV ceremony).
   */
  seed?: boolean;
};

// ISeedStore: session/durable access via Enclave (master seed never leaves enclave.ts).
export interface ISeedStore {
  save: (enclave: Enclave, opts?: SetSeedOpts) => Promise<Enclave>;
  load: () => Promise<Enclave | void>;
  /**
   * Clear durable seed material for this store (IDB row, largeBlob overwrite, …)
   * and drop the in-memory enclave. Called only when client.wipe({ seed: true }).
   */
  wipe: () => Promise<void>;
}

export interface IHostRow<Handle extends HostHandle>
  extends IHostConnectionInfo<Handle>, Partial<IHostMetadata> {
  lastSeq: number;
}

/**
 * Host row cursor write (one store transaction).
 * `lastSeq` only advances unless `setLastSeq` is set.
 */
export type HostStatsUpdate = {
  /** New lastSeq if greater than current (incremental peek/push). */
  lastSeq?: number;
  /** Absolute lastSeq, including rewind (full inventory). */
  setLastSeq?: number;
};

// IHostStore handles persistence of hosts table.
export interface IHostStore<Handle extends HostHandle> {
  add: (host: IHostConnectionInfo<Handle>) => Promise<void>;
  get: (label: string) => Promise<IHostRow<Handle> | undefined>;
  del: (label: string) => Promise<void>;
  set: (label: string, meta: IHostMetadata) => Promise<Status>;
  list: () => Promise<Iterable<IHostRow<Handle>>>;
  wipe: () => Promise<void>;
  // Advance host lastSeq if seq is greater; never rewind.
  touch: (label: string, seq: number) => Promise<void>;
  /** Apply lastSeq updates in one transaction. */
  recordStats: (label: string, u: HostStatsUpdate) => Promise<void>;
}

/** Options for {@link IClient.reconcile}. */
export type ReconcileOpts = {
  /** Enqueue downloads for msgs on host missing locally. Default true. */
  pull?: boolean;
  /** Enqueue uploads for local archive msgs missing on host. Default false. */
  push?: boolean;
  /**
   * After inventory, run {@link IClient.sync} to drain upload/download queues.
   * Default true. Pass false for inventory-only.
   */
  sync?: boolean;
};

/**
 * Result of {@link IClient.reconcile}: host msg checksum and bag tallies from
 * the (post-drain) full inventory. Ephemeral — not persisted.
 */
export type ReconcileReport = {
  /** Distinct msgs on host (same construction as {@link IClient.msgcheck}). */
  msgcheck: Hash;
  /** Total bags on host (includes duplicate bags for the same msg). */
  numBags: number;
  /** Extra bags beyond one per msg. */
  numDupes: number;
};

/** Full inventory details (internal; includes set-diff counts). */
export type ReconcileResult = ReconcileReport & {
  /** Distinct msgs among bags. */
  uniqueMsgs: number;
  /** Msgs on host not in local archive. */
  missingLocal: number;
  /** Local archive msgs not seen on host. */
  missingHost: number;
};

// What to index msgs on?
// Any message with contents has a hsh attribute in the header.
// Therefore, hash of the encoded header would be a good unique key.
// Encryption is per-host, so should not pre-encrypt the message.
// So in this context, hash means blake3 hash of encoded message header.

export interface IUploadQueue {
  enq: (host: string, hshs: Iterable<Hash>) => Promise<void>;
  deq: (host: string, hshs: Iterable<Hash>) => Promise<void>;
  list: (host: string) => Promise<Hash[]>;
  count: () => Promise<number>;
  wipe(): Promise<void>;
}

export interface IDownloadMessage {
  kdm: Uint8Array;
  seq: number;
  head: IMessageHead;
  host: string;
  /**
   * Encoded message head from peek (or notif). When set, open skips re-encode.
   * Prefer always setting this on the peek path.
   */
  headEnc?: Uint8Array;
  /**
   * blake3(headEnc). When set with headEnc, open skips re-hashing the head.
   */
  headEncHash?: Hash;
}
export interface IDownloadQueue {
  enq: (msgs: Iterable<IDownloadMessage>) => Promise<void>;
  deq: (host: string, seqs: Iterable<number>) => Promise<void>;
  list: () => Promise<Iterable<IDownloadMessage>>;
  count: () => Promise<number>;
  wipe(): Promise<void>;
}

/**
 * Apply lifecycle values for archive rows (IDB-indexable single-char strings;
 * booleans are not valid IndexedDB keys). Defined first so {@link ApldState}
 * is only those three literals.
 */
export const APLD_PENDING = "f" as const;
export const APLD_APPLIED = "t" as const;
export const APLD_ERROR = "e" as const;

/** Only {@link APLD_PENDING}, {@link APLD_APPLIED}, or {@link APLD_ERROR}. */
export type ApldState =
  | typeof APLD_PENDING
  | typeof APLD_APPLIED
  | typeof APLD_ERROR;

/**
 * Archive fields shared by read and write.
 */
export interface IStoredMessageFields {
  eid: EntityID;
  off?: number;
  ctr?: number;
  body?: EncodedMessage;
}

/**
 * What may come back from storage (pre-apld rows can omit the field).
 * Typed rows use only {@link ApldState}; {@link apldFromStored} coerces
 * legacy boolean / unknown values at the storage boundary.
 */
export interface IStoredMessageData extends IStoredMessageFields {
  apld?: ApldState;
  /** Status code when apld is {@link APLD_ERROR}. */
  err?: number;
}

/**
 * Required shape for every put into the message archive (app/API layer).
 * `apld` is required and must be one of the three {@link ApldState} values.
 * Omit optional fields (`off`, `ctr`, `body`, `err`) rather than storing empties.
 */
export type IStoredMessageWrite = IStoredMessageFields & {
  apld: ApldState;
  /** Status code when apld is {@link APLD_ERROR}. */
  err?: number;
};

export interface IStorableMessage {
  key: Hash;
  data: IStoredMessageWrite;
}

export interface IStoredMessage {
  hash: Hash;
  head: IMessageHead;
  body?: EncodedMessage;
  /** Apply lifecycle — same {@link ApldState} as the archive row. */
  apld: ApldState;
  /** Status code when apld is {@link APLD_ERROR}. */
  err?: number;
}

/** True only for the three legal {@link ApldState} values. */
export function isApldState(v: unknown): v is ApldState {
  return v === APLD_PENDING || v === APLD_APPLIED || v === APLD_ERROR;
}

/**
 * Coerce raw storage values to {@link ApldState}.
 * Applied: true | APLD_APPLIED. Failed: APLD_ERROR.
 * Pending: false | APLD_PENDING | missing | anything else.
 */
export function apldFromStored(v: unknown): ApldState {
  if (v === true || v === APLD_APPLIED) return APLD_APPLIED;
  if (v === APLD_ERROR) return APLD_ERROR;
  return APLD_PENDING;
}

/** Pending apply when not yet applied or terminally failed. */
export function isPendingApply(data: IStoredMessageData): boolean {
  return apldFromStored(data.apld) === APLD_PENDING;
}

/**
 * Apply failures that should not be retried (poison / protocol / shape).
 * Transient storage errors stay pending ({@link APLD_PENDING}) for a later drain.
 */
export function isTerminalApplyFailure(st: Status): boolean {
  return st !== Status.Success &&
    st !== Status.NoChange &&
    st !== Status.DatabaseError &&
    st !== Status.StorageError;
}

/**
 * Mutate a stored row's apply state in place (no copy).
 * Clears `err` unless setting {@link APLD_ERROR}.
 */
export function setApld(
  data: IStoredMessageData,
  apld: ApldState,
  err?: Status,
): void {
  data.apld = apld;
  if (apld === APLD_ERROR && err !== undefined) {
    data.err = err;
  } else {
    delete data.err;
  }
}

/**
 * Options for archive list / client diagnostics.
 * `body` defaults to **true**. Pass `body: false` for heads + apld + err only.
 */
export type ListMsgsOpts = {
  /** Filter by apply lifecycle; omit for all archive rows. */
  apld?: ApldState;
  /**
   * Include msg bodies and derive `head.hsh` from them.
   * Default `true`. Pass `false` to omit body and `hsh` (cheaper diagnostics);
   * `head.len` still reflects stored size.
   */
  body?: boolean;
};

export async function toStoredMessage(
  hash: Hash,
  data: IStoredMessageData,
  crypto: ICrypto,
  opts?: { body?: boolean },
): Promise<IStoredMessage> {
  // Default include body (get/last/list). Pass body: false to skip payload/hsh.
  const includeBody = opts?.body !== false;
  const apld = apldFromStored(data.apld);
  const raw = data.body;
  const len = raw?.length ?? 0;
  let hsh: Uint8Array | undefined;
  if (includeBody && raw && len > 0) {
    hsh = await crypto.blake3(raw);
  }
  const head: IMessageHead = {
    eid: data.eid,
    off: data.off ?? 0,
    ctr: data.ctr ?? 0,
    len,
    hsh,
  };
  const out: IStoredMessage = {
    hash,
    head,
    apld,
  };
  if (includeBody && raw !== undefined) out.body = raw;
  if (apld === APLD_ERROR && data.err !== undefined) out.err = data.err;
  return out;
}
export interface IMessageStore {
  add: (messages: IStorableMessage[]) => Promise<Status[]>;
  get: (key: Hash) => Promise<IStoredMessage | undefined>;
  has: (key: Hash) => Promise<boolean>;
  del: (keys: Iterable<Hash>) => Promise<void>;
  /**
   * List archive rows. Filter with `apld` (e.g. {@link APLD_ERROR}).
   * Bodies included by default; pass `body: false` to omit.
   */
  list: (opts?: ListMsgsOpts) => Promise<IStoredMessage[]>;
  /** Count archive rows; optional apld filter (IDB index when available). */
  count: (apld?: ApldState) => Promise<number>;
  /** Archive keys only (head hashes). Prefer over {@link list} for checksums. */
  listKeys: () => Promise<Hash[]>;
  last: (eid: EntityID) => Promise<IStoredMessage | undefined>;
  /** Mark archive rows as applied ({@link APLD_APPLIED}). */
  markApplied: (keys: Iterable<Hash>) => Promise<void>;
  /** Mark archive rows as terminal apply failure ({@link APLD_ERROR}). */
  markFailed: (
    entries: Iterable<{ key: Hash; err: Status }>,
  ) => Promise<void>;
  wipe(): Promise<void>;
}

export interface IStore<Handle extends HostHandle> {
  seed: ISeedStore;
  hosts: IHostStore<Handle>;
  uploads: IUploadQueue;
  downloads: IDownloadQueue;
  messages: IMessageStore;
  /**
   * Clear protocol tables (hosts, queues, messages). Does not call seed.wipe.
   */
  wipe(): Promise<void>;
}

type UnlistenFunc = () => void;
export interface IStateEmitter<T> {
  get(): Promise<T>;
  emit(): void;
  listen(listener: (state: T) => void): UnlistenFunc;
}

export interface IClient<Handle extends HostHandle> {
  /** Install session enclave (master seed stays inside enclave). */
  setSeed(enclave: Enclave, opts?: SetSeedOpts): Promise<void>;

  link(host: IHostConnectionInfo<Handle>): Promise<void>;
  unlink(label: string): Promise<void>;
  /** Linked hosts from the protocol store (handle, label, lastSeq, …). */
  hosts(): Promise<IHostRow<Handle>[]>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // insert/update/delete return the msg head. On clock skew, update/delete may
  // issue a delete (+ optional replacement) so the returned head can differ
  // from a naive read of the params.
  insertRaw(content: SerializedContent): Promise<ValStat<IMessageHead>>;
  updateRaw(
    prior: IEntRev,
    content: SerializedContent | undefined,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>>;
  insert<T = unknown>(op: IInsertParams<T>): Promise<ValStat<IMessageHead>>;
  update<T = unknown>(op: IUpdateParams<T>): Promise<ValStat<IMessageHead>>;
  /**
   * Delete by `{ prior }` (preferred) or `{ eid }` (archive lookup).
   */
  delete(op: IDeleteParams): Promise<ValStat<IMessageHead>>;

  /** Allocate an entity id (optional 8-byte id material; else random). */
  genEID(id?: Uint8Array): Promise<ValStat<EntityID>>;

  sync(): Promise<Status>;

  /**
   * Wipe application state (e.g. EntDB) and rebuild it by replaying the local
   * message archive. By default, first peeks the full host header list (seq 0)
   * and pulls any missing bags so the archive is complete before replay.
   * Pass `{ checkHost: false }` to skip the host inventory (local-only).
   */
  rebuild(options?: { checkHost?: boolean }): Promise<Status>;

  /**
   * Checksum of the local msg archive as a set of head hashes.
   * Decodes store keys to raw hashes, sorts lexicographically, blake3(concat).
   * Key encoding (e.g. b64 in IDB) is independent of this definition.
   */
  msgcheck(): Promise<Hash>;

  /**
   * List local archive rows for diagnostics (failed apply, pending drain, dump).
   * Bodies included by default; pass `body: false` for lighter listings.
   */
  listMsgs(opts?: ListMsgsOpts): Promise<IStoredMessage[]>;

  /**
   * Count archive rows; optional apld filter.
   * Prefer over list+length for badges.
   */
  countMsgs(apld?: ApldState): Promise<number>;

  /**
   * Full host inventory (peek from seq 0); optionally enqueue pull/push.
   * Default drains via {@link sync}, then re-inventories. Returns ephemeral
   * host msgcheck + numBags + numDupes (not persisted). Advances lastSeq only
   * on the host row.
   */
  reconcile(
    hostLabel: string,
    opts?: ReconcileOpts,
  ): Promise<ValStat<ReconcileReport>>;

  /**
   * Clear local state. Defaults wipe msgs/ents/meta only; seed requires
   * `{ seed: true }` (avoids passkey UV on ordinary EXIT / data wipe).
   */
  wipe(opts?: WipeOpts): Promise<void>;

  import(file: File): Promise<Status>;
  export(filename: string, extension?: string): Promise<Status>;

  clientState: IStateEmitter<IDiplomaticClientState>;
  xferState: IStateEmitter<IDiplomaticClientXferState>;
}
