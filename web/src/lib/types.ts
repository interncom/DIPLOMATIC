import { IOp } from "../../../cli/src/types";

export interface IClientStateStore {
  init?: () => Promise<void>;
  getSeed: () => Promise<Uint8Array | undefined>;
  setSeed: (seed: Uint8Array) => Promise<void>;
  getHostURL: () => Promise<string | undefined>;
  setHostURL: (url: string) => Promise<void>;
  getHostID: () => Promise<string | undefined>;
  setHostID: (id: string) => Promise<void>;
}

export type DiplomaticClientState = "loading" | "seedless" | "hostless" | "ready";

export type Applier = (op: IOp) => Promise<void>;
