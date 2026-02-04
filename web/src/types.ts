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
  IMessage,
  IMessageHead,
  IOp,
  IUpsertParams,
  MasterSeed,
  SerializedContent,
} from "./shared/types";
import { ValStat } from "./shared/valstat";

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
  touch: (label: string, seq: number) => Promise<void>;
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
  last: (eid: EntityID, clk: Date) => Promise<IStoredMessage | undefined>;
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

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // insert/upsert/delete return the msg head, because in case of clock skew,
  // they may issue a delete and replace with a new msg to get back on a valid
  // timeline. If that happens, the returned msg head will be different than
  // the one implied by the provided params.
  insertRaw(content: SerializedContent): Promise<ValStat<IMessageHead>>;
  upsertRaw(
    eid: EntityID,
    clk: Date,
    content: SerializedContent,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>>;
  insert<T = unknown>(op: IInsertParams<T>): Promise<ValStat<IMessageHead>>;
  upsert<T = unknown>(
    op: IUpsertParams<T>,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>>;
  delete(eid: EntityID, clk: Date): Promise<ValStat<IMessageHead>>;

  sync(): Promise<Status>;

  wipe(): Promise<void>;

  import(file: File): Promise<Status>;
  export(filename: string, extension?: string): Promise<Status>;

  clientState: IStateEmitter<IDiplomaticClientState>;
  xferState: IStateEmitter<IDiplomaticClientXferState>;
}

export interface IStateManager {
  apply: (msg: IMessage) => Promise<Status>;
  on: (type: string, listener: () => void) => void;
  off: (type: string, listener: () => void) => void;
}
