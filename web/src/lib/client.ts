import { decode } from "@msgpack/msgpack";
import type { IOp } from "../../../cli/src/types.ts";
import { decrypt, deriveEncryptionKey, encrypt, serialize } from "./crypto.ts";
import { getHostID, register, putDelta, getDeltaPaths, getDelta } from "./api.ts";
import { type KeyPair, deriveAuthKeyPair } from "./auth.ts";

export interface IClientStateStore {
  getSeed: () => Promise<Uint8Array | undefined>;
  setSeed: (seed: Uint8Array) => Promise<void>;
}

export type DiplomaticClientState = "loading" | "seedless" | "hostless" | "ready";

export default class DiplomaticClient {
  store: IClientStateStore;

  listener?: (state: DiplomaticClientState) => void;

  seed?: Uint8Array;
  encKey?: Uint8Array;
  hostURL?: URL;
  hostKeyPair?: KeyPair;
  lastFetchedAt?: string;

  constructor(store: IClientStateStore) {
    this.store = store;
    this.init();
  }

  async init() {
    await this.loadSeed();
  }

  async loadSeed() {
    // TODO: extract to pluggable storage module.
    const seed = await this.store.getSeed();
    if (seed) {
      // TODO: check validity.
      this.setSeed(seed);
    }
  }

  get state(): DiplomaticClientState {
    if (!this.seed || !this.encKey) {
      return "seedless";
    }
    if (!this.hostURL || !this.hostKeyPair) {
      return "hostless";
    }
    return "ready";
  }

  setSeed(seed: Uint8Array) {
    this.seed = seed;
    this.encKey = deriveEncryptionKey(seed);
    this.store.setSeed(seed);
    this.listener?.(this.state);
  }

  async register(hostURL: string) {
    if (!this.seed) {
      return;
    }
    this.hostURL = new URL(hostURL);
    const hostID = await getHostID(hostURL);
    this.hostKeyPair = deriveAuthKeyPair(hostID, this.seed);
    await register(hostURL, this.hostKeyPair.publicKey, "tok123");
    this.listener?.(this.state);
  }

  async putDelta(delta: IOp<"status">) {
    if (!this.hostURL || !this.hostKeyPair || !this.encKey) {
      return [];
    }
    const packed = serialize(delta);
    const cipherOp = encrypt(packed, this.encKey);
    await putDelta(this.hostURL, cipherOp, this.hostKeyPair);
  }

  async getDeltas(): Promise<IOp<"status">[]> {
    if (!this.hostURL || !this.hostKeyPair || !this.encKey) {
      return [];
    }
    const begin = new Date(this.lastFetchedAt ?? 0);
    const pathResp = await getDeltaPaths(this.hostURL, begin, this.hostKeyPair);
    const paths = pathResp.paths;
    this.lastFetchedAt = pathResp.fetchedAt;
    const deltas: IOp<"status">[] = [];
    for (const path of paths) {
      const cipher = await getDelta(this.hostURL, path, this.hostKeyPair);
      const deltaPack = decrypt(cipher, this.encKey)
      const delta = decode(deltaPack) as IOp<"status">;
      deltas.push(delta);
    }

    return deltas;
  }

  async processDeltas(apply: (delta: IOp<"status">) => void) {
    const deltas = await this.getDeltas();
    for (const delta of deltas) {
      apply(delta);
    }
  }
}
