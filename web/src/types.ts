import type { IDeltaListItem, IOp } from "./shared/types";

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
}

export interface IDiplomaticClientState {
  hasSeed: boolean;
  hasHost: boolean;
  connected: boolean;
  numUploads: number;
  numDownloads: number;
}

export type Applier = (op: IOp) => Promise<void>;
