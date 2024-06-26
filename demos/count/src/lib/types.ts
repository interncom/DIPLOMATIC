import type { IOp } from "../../../../shared/types";

export interface IClientStateStore {
  init?: () => Promise<void>;
  getSeed: () => Promise<Uint8Array | undefined>;
  setSeed: (seed: Uint8Array) => Promise<void>;
  getHostURL: () => Promise<string | undefined>;
  setHostURL: (url: string) => Promise<void>;
  getHostID: () => Promise<string | undefined>;
  setHostID: (id: string) => Promise<void>;
  enqueueUpload: (sha256: Uint8Array, cipherOp: Uint8Array) => Promise<void>;
  dequeueUpload: (sha256: Uint8Array) => Promise<void>;
  peekUpload: (sha256: Uint8Array) => Promise<Uint8Array | undefined>;
  listUploadQueue: () => Promise<string[]>;
  enqueueDownload: (path: string) => Promise<void>;
  dequeueDownload: (path: string) => Promise<void>;
}

export type DiplomaticClientState = "loading" | "seedless" | "hostless" | "ready";

export type Applier = (op: IOp) => Promise<void>;
