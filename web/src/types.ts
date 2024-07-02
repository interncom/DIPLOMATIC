import type { IOp, IStorage } from "./shared/types";

export interface IClientStateStore {
  init?: () => Promise<void>;
  getSeed: () => Promise<Uint8Array | undefined>;
  setSeed: (seed: Uint8Array) => Promise<void>;
  getHostURL: () => Promise<string | undefined>;
  setHostURL: (url: string) => Promise<void>;
  getHostID: () => Promise<string | undefined>;
  setHostID: (id: string) => Promise<void>;

  enqueueUpload: (sha256: string, cipherOp: Uint8Array) => Promise<void>;
  dequeueUpload: (sha256: string) => Promise<void>;
  peekUpload: (sha256: string) => Promise<Uint8Array | undefined>;
  listUploads: () => Promise<string[]>;

  enqueueDownload: (path: string) => Promise<void>;
  dequeueDownload: (path: string) => Promise<void>;
  listDownloads: () => Promise<string[]>;
}

export type DiplomaticClientState = "loading" | "seedless" | "hostless" | "ready";

export type Applier = (op: IOp) => Promise<void>;
