import { decode, encode } from "@msgpack/msgpack";
import type { IOp, KeyPair } from "../../../../shared/types.ts";
import webClientAPI from "./api.ts";
import type { IClientStateStore, DiplomaticClientState, Applier } from "./types.ts";
import libsodiumCrypto from "./crypto.ts";
import type { StateManager } from "./state.ts";
import { genUpsertOp } from "./ops.ts";
import { htob } from "../../../../shared/lib.ts";

export interface IDiplomaticClientParams {
  store: IClientStateStore;
  stateManager: StateManager;
  seed?: string | Uint8Array;
  hostURL?: URL;
  hostID?: string;
}

export default class DiplomaticClient {
  store: IClientStateStore;
  applier: Applier;

  listener?: (state: DiplomaticClientState) => void;

  seed?: Uint8Array;
  encKey?: Uint8Array;
  hostURL?: URL;
  hostKeyPair?: KeyPair;
  lastFetchedAt?: string;

  constructor(params: IDiplomaticClientParams) {
    this.store = params.store;
    this.applier = params.stateManager.apply;
    this.init(params);
  }

  async init(params: IDiplomaticClientParams) {
    await this.store.init?.();
    if (params.seed) {
      const bytes = typeof params.seed === "string" ? htob(params.seed) : params.seed;
      await this.store.setSeed(bytes);
    }
    await this.loadSeed();
    if (params.hostID && params.hostURL) {
      await this.store.setHostID(params.hostID);
      await this.store.setHostURL(params.hostURL);
    } else if (params.hostURL) {
      await this.register(params.hostURL);
    } else {
      await this.loadHost();
    }
    this.listener?.(this.state);
  }

  async loadSeed() {
    const seed = await this.store.getSeed();
    if (seed) {
      // TODO: check validity.
      this.seed = seed;
      this.encKey = await libsodiumCrypto.deriveXSalsa20Poly1305Key(seed);
    }
  }

  async setSeed(seed: Uint8Array) {
    this.seed = seed;
    this.encKey = await libsodiumCrypto.deriveXSalsa20Poly1305Key(seed);
    await this.store.setSeed(seed);
    this.listener?.(this.state);
  }

  async loadHost() {
    if (!this.seed) {
      return;
    }
    const hostURL = await this.store.getHostURL();
    const hostID = await this.store.getHostID();
    if (!hostURL || !hostID) {
      return;
    }
    this.hostURL = new URL(hostURL);
    this.hostKeyPair = await libsodiumCrypto.deriveEd25519KeyPair(this.seed, hostID);
  }

  // TODO: dedupe with loadHost.
  async register(hostURL: string) {
    if (!this.seed) {
      return;
    }
    this.hostURL = new URL(hostURL);
    const hostID = await webClientAPI.getHostID(this.hostURL);
    this.hostKeyPair = await libsodiumCrypto.deriveEd25519KeyPair(this.seed, hostID);
    await webClientAPI.register(this.hostURL, this.hostKeyPair.publicKey, "tok123");

    await this.store.setHostURL(hostURL);
    await this.store.setHostID(hostID);

    this.listener?.(this.state);
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

  private async putDelta(delta: IOp) {
    if (!this.hostURL || !this.hostKeyPair || !this.encKey) {
      return;
    }
    const packed = encode(delta);
    const cipherOp = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(packed, this.encKey);
    await webClientAPI.putDelta(this.hostURL, cipherOp, this.hostKeyPair);
  }

  async getDeltas(): Promise<IOp[]> {
    if (!this.hostURL || !this.hostKeyPair || !this.encKey) {
      return [];
    }
    const begin = new Date(this.lastFetchedAt ?? 0);
    const pathResp = await webClientAPI.getDeltaPaths(this.hostURL, begin, this.hostKeyPair);
    const paths = pathResp.paths;
    this.lastFetchedAt = pathResp.fetchedAt;
    // console.time("getting")
    const deltas = await Promise.all(paths.map(async (path) => {
      const cipher = await webClientAPI.getDelta(this.hostURL, path, this.hostKeyPair);
      const deltaPack = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(cipher, this.encKey);
      const delta = decode(deltaPack) as IOp;
      return delta;
    }))
    // console.timeEnd("getting")

    return deltas;
  }

  async processDeltas() {
    const deltas = await this.getDeltas();
    for (const delta of deltas) {
      await this.applier(delta);
    }
  }

  private async pushQueuedOp(sha256: Uint8Array) {
    if (!this.hostURL || !this.hostKeyPair) {
      return;
    }
    const cipherOp = await this.store.peekUpload(sha256);
    if (cipherOp) {
      await webClientAPI.putDelta(this.hostURL, cipherOp, this.hostKeyPair);
    }
    await this.store.dequeueUpload(sha256);
  }

  async pushQueuedOps() {
    for (const sha256 of await this.store.listUploadQueue()) {
      await this.pushQueuedOp(sha256);
    }
  }

  async apply(op: IOp) {
    // NOTE: DIPLOMATIC *must* ensure the delta is queued before locally executing it.
    // This has the potential to cause lag before UI updates, but the greater evil is to update local state first but fail to queue the delta for sync, causing remote state to never match local.
    const packed = encode(op);
    const cipherOp = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(packed, this.encKey);
    const sha256 = await libsodiumCrypto.sha256Hash(cipherOp);
    await this.store.enqueueUpload(sha256, cipherOp);

    try {
      await this.applier(op);
    } catch {
      // If op can't be applied locally, don't burden anyone else with it.
      await this.store.dequeueUpload(sha256);
    }

    await this.pushQueuedOp(sha256);
    // If this fails, it will remain in the queue to be retried later.
  }

  async upsert<T>(type: string, body: T, version = 0) {
    const op = genUpsertOp<T>(type, body, version);
    return this.apply(op);
  }
}