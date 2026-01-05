import type { Hash, IOp, MasterSeed } from "./shared/types";
import type { SerializedContent } from "./shared/message";
import type { Enclave } from "./shared/enclave";

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

export type Applier = (op: IOp) => Promise<void>;

// ISeedStore handles persistence for a MasterSeed.
export interface ISeedStore {
  init: () => Promise<void>;
  save: (seed: MasterSeed) => Promise<void>;
  load: () => Promise<Enclave>;
  wipe: () => Promise<void>;
}

interface IHost {
  label: string;
  url: URL;
  lastSyncedAt: Date;
}

// IHostStore handles persistence of hosts table.
export interface IHostStore {
  init: () => Promise<void>;
  add: (label: string, url: URL) => Promise<void>;
  del: (label: string) => Promise<void>;
  list: () => Promise<IHost[]>;
  wipe: () => Promise<void>;
}

// What to index msgs on?
// Any message with contents has a hsh attribute in the header.
// Therefore, hash of the encoded header would be a good unique key.
// Encryption is per-host, so should not pre-encrypt the message.
// So in this context, hash means blake3 hash of encoded message header.

export interface IUploadQueue {
  init: () => Promise<void>;
  enq: (hashes: Hash[]) => Promise<void>;
  deq: (hashes: Hash[]) => Promise<void>;
  list: () => Promise<Uint8Array[]>;
  count: () => Promise<number>;
}

// Separate table for download queue?
// Or just split message head and body into separate tables.
// Then downloaded could be a flag on the heads table.
// And PEEK would just fill the heads table.
// Otherwise PULLs will mutate the messages table,
// when they could just append to the bodies table.
// No. They would have to flip the downloaded flag on heads anyway.
// Think through this arch...
interface IDownload {
  host: string;
}
export interface IDownloadQueue {
  init: () => Promise<void>;
  enq: (hash: Hash, head: IMessageHead, hostLabel: string) => Promise<void>;
  deq: (hash: Hash) => Promise<void>;
  list: () => Promise<IMessageHead[]>;
  count: () => Promise<number>;
}

interface IStoredMessage {
  hash: Hash;
  head: IMessageHead;
  body?: EncodedMessage;
}
export interface IMessageStore {
  init: () => Promise<void>;
  add: (messages: Iterable<IStoredMessage>) => Promise<void>;
  del: (hashes: Iterable<Hash>) => Promise<void>;
  has: (hash: Hash) => Promise<boolean>;
  list: () => Promise<IStoredMessage[]>;
}
