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

export interface IDiplomaticClientXferState {
  numUploads: number;
  numDownloads: number;
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

export interface IStorableMessage {
  key: Hash;
  data: IStoredMessageData;
}
export interface IStoredMessage {
  hash: Hash;
  head: IMessageHead;
  body?: EncodedMessage;
}
export interface IStoredMessageData {
  eid: EntityID;
  off?: number;
  ctr?: number;
  body?: EncodedMessage;
}
export async function toStoredMessage(
  hash: Hash,
  data: IStoredMessageData,
  crypto: ICrypto,
): Promise<IStoredMessage> {
  const len = data.body?.length ?? 0;
  let hsh: Uint8Array | undefined;
  if (data.body && len > 0) {
    hsh = await crypto.blake3(data.body);
  }
  const head: IMessageHead = {
    eid: data.eid,
    off: data.off ?? 0,
    ctr: data.ctr ?? 0,
    len,
    hsh,
  };
  return { hash, head, body: data.body };
}
export interface IMessageStore {
  add: (messages: IStorableMessage[]) => Promise<Status[]>;
  get: (key: Hash) => Promise<IStoredMessage | undefined>;
  has: (key: Hash) => Promise<boolean>;
  del: (keys: Iterable<Hash>) => Promise<void>;
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
    content: SerializedContent,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>>;
  insert<T = unknown>(op: IInsertParams<T>): Promise<ValStat<IMessageHead>>;
  upsert<T = unknown>(
    op: IUpsertParams<T>,
    force?: boolean,
  ): Promise<ValStat<IMessageHead>>;
  delete(eid: EntityID): Promise<ValStat<IMessageHead>>;

  sync(): Promise<Status>;

  wipe(): Promise<void>;

  import(file: File): Promise<Status>;
  export(filename: string, extension?: string): Promise<Status>;

  clientState: IStateEmitter<IDiplomaticClientState>;
  xferState: IStateEmitter<IDiplomaticClientXferState>;
}
