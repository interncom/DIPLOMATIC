import type { SyncProgressEvent } from "./progress";
import { Status } from "./shared/consts";
import type { Enclave } from "./shared/enclave";
import type { EncodedMessage } from "./shared/message";
import type {
  EntityID,
  Hash,
  HostHandle,
  IHostConnectionInfo,
  IHostMetadata,
  IInsertParams,
  IMessageHead,
  IOp,
  IUpsertParams,
  MasterSeed,
  SerializedContent,
} from "./shared/types";
import { ValStat } from "./shared/valstat";
import { ICrypto } from "./shared/types";

export interface IMsgParts {
  head: IMessageHead;
  body?: EncodedMessage;
}

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
) => Promise<{ stats: Status[]; types: Set<string> }>;

// ISeedStore handles persistence for a MasterSeed.
export interface ISeedStore {
  save: (seed: MasterSeed) => Promise<Enclave>;
  load: () => Promise<Enclave | void>;
  wipe: () => Promise<void>;
}

export interface IHostRow<Handle extends HostHandle>
  extends IHostConnectionInfo<Handle>, Partial<IHostMetadata> {
  lastSeq: number;
}

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
}

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
}
export interface IDownloadQueue {
  enq: (msgs: Iterable<IDownloadMessage>) => Promise<void>;
  deq: (host: string, seqs: Iterable<number>) => Promise<void>;
  list: () => Promise<Iterable<IDownloadMessage>>;
  count: () => Promise<number>;
  wipe(): Promise<void>;
}

/**
 * Archive fields shared by read and write.
 * `apld`: true once the msg has been applied by the application state manager;
 * false while still pending apply.
 */
export interface IStoredMessageFields {
  eid: EntityID;
  off?: number;
  ctr?: number;
  body?: EncodedMessage;
}

/**
 * What may come back from storage (pre-apld rows can omit the field).
 * IDB stores "t"|"f" (booleans are not valid IndexedDB index keys).
 * Prefer {@link normalizeStoredMessageData} before use.
 */
export interface IStoredMessageData extends IStoredMessageFields {
  apld?: boolean | "t" | "f";
}

/**
 * Required shape for every put into the message archive (app/API layer).
 * Callers must set `apld` (false until applied, then true).
 * The IDB adapter persists this as "t"|"f" for indexing.
 */
export type IStoredMessageWrite = IStoredMessageFields & {
  apld: boolean;
};

export interface IStorableMessage {
  key: Hash;
  data: IStoredMessageWrite;
}

export interface IStoredMessage {
  hash: Hash;
  head: IMessageHead;
  body?: EncodedMessage;
  applied: boolean; // True once this msg has been applied by the application state manager.
}

/**
 * Coerce stored `apld` to boolean.
 * Applied: true | "t". Pending: false | "f" | missing.
 */
export function apldFromStored(v: unknown): boolean {
  return v === true || v === "t";
}

/** Coerce storage rows to the write shape with boolean apld. */
export function normalizeStoredMessageData(
  data: IStoredMessageData,
): IStoredMessageWrite {
  return {
    eid: data.eid,
    ...(data.off !== undefined ? { off: data.off } : {}),
    ...(data.ctr !== undefined ? { ctr: data.ctr } : {}),
    ...(data.body !== undefined ? { body: data.body } : {}),
    apld: data.apld === undefined ? false : apldFromStored(data.apld),
  };
}

/** Pending apply when not yet marked applied. */
export function isPendingApply(data: IStoredMessageData): boolean {
  return normalizeStoredMessageData(data).apld === false;
}

export async function toStoredMessage(
  hash: Hash,
  data: IStoredMessageData,
  crypto: ICrypto,
): Promise<IStoredMessage> {
  const norm = normalizeStoredMessageData(data);
  const len = norm.body?.length ?? 0;
  let hsh: Uint8Array | undefined;
  if (norm.body && len > 0) {
    hsh = await crypto.blake3(norm.body);
  }
  const head: IMessageHead = {
    eid: norm.eid,
    off: norm.off ?? 0,
    ctr: norm.ctr ?? 0,
    len,
    hsh,
  };
  return {
    hash,
    head,
    body: norm.body,
    applied: norm.apld,
  };
}
export interface IMessageStore {
  add: (messages: IStorableMessage[]) => Promise<Status[]>;
  get: (key: Hash) => Promise<IStoredMessage | undefined>;
  has: (key: Hash) => Promise<boolean>;
  del: (keys: Iterable<Hash>) => Promise<void>;
  list: () => Promise<Iterable<IStoredMessage>>;
  last: (eid: EntityID) => Promise<IStoredMessage | undefined>;
  /** Messages stored but not yet applied (apld === false). */
  listUnapplied: () => Promise<IStoredMessage[]>;
  /** Mark archive rows as applied (apld = true). */
  markApplied: (keys: Iterable<Hash>) => Promise<void>;
  wipe(): Promise<void>;
}

export interface IStore<Handle extends HostHandle> {
  seed: ISeedStore;
  hosts: IHostStore<Handle>;
  uploads: IUploadQueue;
  downloads: IDownloadQueue;
  messages: IMessageStore;
  wipe(): Promise<void>;
}

type UnlistenFunc = () => void;
export interface IStateEmitter<T> {
  get(): Promise<T>;
  emit(): void;
  listen(listener: (state: T) => void): UnlistenFunc;
}

export interface IClient<Handle extends HostHandle> {
  setSeed(seed: MasterSeed): Promise<void>;

  link(host: IHostConnectionInfo<Handle>): Promise<void>;
  unlink(label: string): Promise<void>;
  /** Linked hosts from the protocol store (handle, label, lastSeq, …). */
  hosts(): Promise<IHostRow<Handle>[]>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // insert/upsert/delete return the msg head, because in case of clock skew,
  // they may issue a delete and replace with a new msg to get back on a valid
  // timeline. If that happens, the returned msg head will be different than
  // the one implied by the provided params.
  insertRaw(content: SerializedContent): Promise<ValStat<IMessageHead>>;
  upsertRaw(
    eid: EntityID,
    content: SerializedContent,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>>;
  insert<T = unknown>(op: IInsertParams<T>): Promise<ValStat<IMessageHead>>;
  upsert<T = unknown>(
    op: IUpsertParams<T>,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>>;
  delete(eid: EntityID): Promise<ValStat<IMessageHead>>;

  /** Allocate an entity id (optional 8-byte id material; else random). */
  genEID(id?: Uint8Array): Promise<ValStat<EntityID>>;

  sync(): Promise<Status>;

  wipe(): Promise<void>;

  import(file: File): Promise<Status>;
  export(filename: string, extension?: string): Promise<Status>;

  clientState: IStateEmitter<IDiplomaticClientState>;
  xferState: IStateEmitter<IDiplomaticClientXferState>;
}
