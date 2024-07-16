import type { IOp } from "./shared/types";

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

  enqueueUpload: (sha256: string, cipherOp: Uint8Array) => Promise<void>;
  dequeueUpload: (sha256: string) => Promise<void>;
  peekUpload: (sha256: string) => Promise<Uint8Array | undefined>;
  listUploads: () => Promise<string[]>;
  numUploads: () => Promise<number>;

  enqueueDownload: (path: string) => Promise<void>;
  dequeueDownload: (path: string) => Promise<void>;
  listDownloads: () => Promise<string[]>;
  numDownloads: () => Promise<number>;
}

export interface IDiplomaticClientState {
  hasSeed: boolean;
  hasHost: boolean;
  connected: boolean;
  numUploads: number;
  numDownloads: number;
}

export type Applier = (op: IOp) => Promise<void>;
