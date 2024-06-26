import { decode, encode } from "@msgpack/msgpack";
import type { IOp, KeyPair } from "../../../../shared/types.ts";
import webClientAPI from "./api.ts";
import type { IClientStateStore, DiplomaticClientState, Applier } from "./types.ts";
import libsodiumCrypto from "./crypto.ts";

export default class DiplomaticClient {
  store: IClientStateStore;
  applier: Applier;

  listener?: (state: DiplomaticClientState) => void;

  seed?: Uint8Array;
  encKey?: Uint8Array;
  hostURL?: URL;
  hostKeyPair?: KeyPair;
  lastFetchedAt?: string;

  constructor(store: IClientStateStore, applier: Applier) {
    this.store = store;
    this.applier = applier;
    this.init();
  }

  async init() {
    await this.store.init?.();
    await this.loadSeed();
    await this.loadHost();
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
    this.store.setSeed(seed);
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

  async putDelta(delta: IOp) {
    if (!this.hostURL || !this.hostKeyPair || !this.encKey) {
      return [];
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
    const deltas: IOp[] = [];
    for (const path of paths) {
      const cipher = await webClientAPI.getDelta(this.hostURL, path, this.hostKeyPair);
      const deltaPack = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(cipher, this.encKey);
      const delta = decode(deltaPack) as IOp;
      deltas.push(delta);
    }

    return deltas;
  }

  async processDeltas() {
    const deltas = await this.getDeltas();
    for (const delta of deltas) {
      await this.applier(delta);
    }
  }

  async apply(delta: IOp) {
    // TODO: just enqueue it--doesn't need to be put yet.
    // NOTE: DIPLOMATIC *must* ensure the delta is queued before locally executing it.
    // This has the potential to cause lag before UI updates, but the greater evil is to update local state first but fail to queue the delta for sync, causing remote state to never match local.
    await this.putDelta(delta);

    try {
      await this.applier(delta);

      // TODO: push delta.
      // await this.putDelta(delta);
    } catch {
      // TODO: if delta fails to apply, delete queued delta.
      // Therefore, never push deltas until delta application succeeds.
    }
  }
}
