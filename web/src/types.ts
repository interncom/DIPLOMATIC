import { Status } from "./shared/consts";
import type { Enclave } from "./shared/enclave";
import type {
  EncodedMessage,
  IMessage,
  IMessageHead,
  SerializedContent,
} from "./shared/message";
import type {
  EntityID,
  Hash,
  HostHandle,
  IHostConnectionInfo,
  IOp,
  MasterSeed,
} from "./shared/types";

export interface IDiplomaticClientState {
  hasSeed: boolean;
  hasHost: boolean;
  connected: boolean;
}

export interface IDiplomaticClientXferState {
  numUploads: number;
  numDownloads: number;
}

export type Applier = (op: IOp) => Promise<Status>;

// ISeedStore handles persistence for a MasterSeed.
export interface ISeedStore {
  save: (seed: MasterSeed) => Promise<Enclave>;
  load: () => Promise<Enclave | void>;
  wipe: () => Promise<void>;
}

export interface IHostRow<Handle extends HostHandle>
  extends IHostConnectionInfo<Handle> {
  lastSyncedAt: Date;
}

// IHostStore handles persistence of hosts table.
export interface IHostStore<Handle extends HostHandle> {
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
  enq: (hshs: Iterable<Hash>) => Promise<void>;
  deq: (hshs: Iterable<Hash>) => Promise<void>;
  list: () => Promise<Iterable<Hash>>;
  count: () => Promise<number>;
  wipe(): Promise<void>;
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
  enq: (msgs: Iterable<IDownloadMessage>) => Promise<void>;
  deq: (hshs: Iterable<Hash>) => Promise<void>;
  list: () => Promise<Iterable<IDownloadMessage>>;
  count: () => Promise<number>;
  wipe(): Promise<void>;
}

export interface IStoredMessage {
  hash: Hash;
  head: IMessageHead;
  body?: EncodedMessage;
}
export interface IMessageStore {
  add: (msgs: Iterable<IStoredMessage>) => Promise<void>;
  get: (hash: Hash) => Promise<IStoredMessage | undefined>;
  has: (hash: Hash) => Promise<boolean>;
  del: (hshs: Iterable<Hash>) => Promise<void>;
  list: () => Promise<Iterable<IStoredMessage>>;
  last: (eid: EntityID) => Promise<IStoredMessage | undefined>;
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
  link(host: IHostConnectionInfo<Handle>): Promise<void>;
  unlink(label: string): Promise<void>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  insertRaw(content: SerializedContent): Promise<Status>;
  upsertRaw(eid: EntityID, content: SerializedContent): Promise<Status>;
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
