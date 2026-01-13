import type {
  EntityID,
  Hash,
  HostHandle,
  IHostConnectionInfo,
  INeoOp,
  IOp,
  MasterSeed,
} from "./shared/types";
import type {
  EncodedMessage,
  IMessage,
  IMessageHead,
  SerializedContent,
} from "./shared/message";
import type { Enclave } from "./shared/enclave";
import { Status } from "./shared/consts";

export interface IClientStateStore {
  init?: () => Promise<void>;
  getSeed: () => Promise<Uint8Array | undefined>;
  setSeed: (seed: Uint8Array) => Promise<void>;
  getHostURL: () => Promise<string | undefined>;
  setHostURL: (url: string) => Promise<void>;
  getHostID: () => Promise<string | undefined>;
  setHostID: (id: string) => Promise<void>;
  setLastFetchedAt: (ts: Date) => Promise<void>;
  getLastFetchedAt: () => Promise<Date | undefined>;
  wipe: () => Promise<void>;

  enqueueUpload: (sha256: Uint8Array, cipherOp: Uint8Array) => Promise<void>;
  dequeueUpload: (sha256: Uint8Array) => Promise<void>;
  peekUpload: (sha256: Uint8Array) => Promise<Uint8Array | undefined>;
  listUploads: () => Promise<Uint8Array[]>;
  numUploads: () => Promise<number>;

  enqueueDownload: (sha256: Uint8Array, recordedAt: Date) => Promise<void>;
  dequeueDownload: (sha256: Uint8Array) => Promise<void>;
  listDownloads: () => Promise<IDeltaListItem[]>;
  numDownloads: () => Promise<number>;

  storeOp: (sha256: Uint8Array, cipherOp: Uint8Array) => Promise<void>;
  clearOp: (sha256: Uint8Array) => Promise<void>;
  listOps: () => Promise<
    Array<{
      cipherOp: Uint8Array;
      sha256: string;
    }>
  >;
  hasOp: (sha256: Uint8Array) => Promise<boolean>;
}

export interface IDiplomaticClientState {
  hasSeed: boolean;
  hasHost: boolean;
  connected: boolean;
}

export interface IDiplomaticClientXferState {
  numUploads: number;
  numDownloads: number;
}

export type Applier = (op: INeoOp) => Promise<Status>;

export interface IEntDB {
  apply: Applier;
  clear: () => Promise<Status>;
}

// ISeedStore handles persistence for a MasterSeed.
export interface ISeedStore {
  init: () => Promise<void>;
  save: (seed: MasterSeed) => Promise<Enclave>;
  load: () => Promise<Enclave | void>;
  wipe: () => Promise<void>;
}

export interface IHostRow<Handle extends HostHandle> extends IHostConnectionInfo<Handle> {
  lastSyncedAt: Date;
}

// IHostStore handles persistence of hosts table.
export interface IHostStore<Handle extends HostHandle> {
  init: () => Promise<void>;
  add: (host: IHostConnectionInfo<Handle>) => Promise<void>;
  get: (label: string) => Promise<IHostRow<Handle> | undefined>;
  del: (label: string) => Promise<void>;
  list: () => Promise<Iterable<IHostRow<Handle>>>;
  wipe: () => Promise<void>;
}

// What to index msgs on?
// Any message with contents has a hsh attribute in the header.
// Therefore, hash of the encoded header would be a good unique key.
// Encryption is per-host, so should not pre-encrypt the message.
// So in this context, hash means blake3 hash of encoded message header.

export interface IUploadQueue {
  init: () => Promise<void>;
  enq: (hshs: Iterable<Hash>) => Promise<void>;
  deq: (hshs: Iterable<Hash>) => Promise<void>;
  list: () => Promise<Iterable<Hash>>;
  count: () => Promise<number>;
}

export interface IDeltaListItem {
  sha256: Uint8Array;
  recordedAt: Date;
}

export interface IDownloadMessage {
  kdm: Uint8Array;
  hash: Hash;
  head: IMessageHead;
  host: string;
}
export interface IDownloadQueue {
  init: () => Promise<void>;
  enq: (msgs: Iterable<IDownloadMessage>) => Promise<void>;
  deq: (hshs: Iterable<Hash>) => Promise<void>;
  list: () => Promise<Iterable<IDownloadMessage>>;
  count: () => Promise<number>;
}

export interface IStoredMessage {
  hash: Hash;
  head: IMessageHead;
  body?: EncodedMessage;
}
export interface IMessageStore {
  init: () => Promise<void>;
  add: (msgs: Iterable<IStoredMessage>) => Promise<void>;
  get: (hash: Hash) => Promise<IStoredMessage | undefined>;
  has: (hash: Hash) => Promise<boolean>;
  del: (hshs: Iterable<Hash>) => Promise<void>;
  list: () => Promise<Iterable<IStoredMessage>>;
  last: (eid: EntityID) => Promise<IStoredMessage | undefined>
}

export interface IStore<Handle extends HostHandle> {
  init: () => Promise<void>;
  seed: ISeedStore;
  hosts: IHostStore<Handle>;
  uploads: IUploadQueue;
  downloads: IDownloadQueue;
  messages: IMessageStore;
}

export interface IStateEmitter<T> {
  get(): Promise<T>;
  emit(): void;
  listen(listener: (state: T) => void): void;
}

export interface IClient<Handle extends HostHandle> {
  link(host: IHostConnectionInfo<Handle>): Promise<void>;
  unlink(label: string): Promise<void>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  insert(content: SerializedContent): Promise<Status>;
  upsert(eid: EntityID, content: SerializedContent): Promise<Status>;
  delete(eid: EntityID): Promise<Status>;

  sync(): Promise<void>;

  wipe(): Promise<void>;

  import(file: File): Promise<void>;
  export(filename: string, extension?: string): Promise<void>;

  clientState: IStateEmitter<IDiplomaticClientState>;
  xferState: IStateEmitter<IDiplomaticClientXferState>;
}

export interface IStateManager {
  apply: (msg: IMessage) => Promise<Status>;
  on: (type: string, listener: () => void) => void;
  off: (type: string, listener: () => void) => void;
}
