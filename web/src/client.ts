import { decode, encode } from "@msgpack/msgpack";
import type { EntityID, GroupID, IOp, KeyPair } from "./shared/types";
import { htob } from "./shared/binary";
import webClientAPI from "./api";
import type {
  IClientStateStore,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
} from "./types";
import libsodiumCrypto from "./crypto";
import type { StateManager } from "./state";
import { genDeleteOp, genUpsertOp } from "./shared/ops";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { TypedEventEmitter } from "./events";
import { WebsocketManager } from "./sockets";

export interface IDiplomaticClientParams {
  store: IClientStateStore;
  stateManager: StateManager;
  seed?: string | Uint8Array;
  hostURL?: string;
  hostID?: string;
}

export default class DiplomaticClient {
  store: IClientStateStore;
  stateManager: StateManager;

  stateEmitter: TypedEventEmitter<IDiplomaticClientState>;
  xferStateEmitter: TypedEventEmitter<IDiplomaticClientXferState>;

  seed?: Uint8Array;
  encKey?: Uint8Array;
  hostURL?: URL;
  hostKeyPair?: KeyPair;
  private websocketManager: WebsocketManager;

  constructor(params: IDiplomaticClientParams) {
    this.stateEmitter = new TypedEventEmitter();
    this.xferStateEmitter = new TypedEventEmitter();
    this.store = params.store;
    this.stateManager = params.stateManager;
    this.websocketManager = new WebsocketManager(this);
    this.init(params);
  }

  addEventListener(func: (state: IDiplomaticClientState) => void) {
    return this.stateEmitter.addEventListener("update", func);
  }

  addXferEventListener(func: (state: IDiplomaticClientXferState) => void) {
    return this.xferStateEmitter.addEventListener("update", func);
  }

  wipe = async () => {
    this.seed = undefined;
    this.encKey = undefined;
    this.hostURL = undefined;
    this.hostKeyPair = undefined;
    this.websocketManager.disconnect();
    await this.stateManager.clear();
    await this.store.wipe();
    this.emitUpdate();
  };

  connect = (hostURL: URL) => {
    this.websocketManager.connect(hostURL);
  };

  async init(params: IDiplomaticClientParams) {
    await this.store.init?.();

    if (params.seed) {
      const bytes = typeof params.seed === "string"
        ? htob(params.seed)
        : params.seed;
      await this.store.setSeed(bytes);
    }
    await this.loadSeed();
    this.emitUpdate();
    if (params.hostID && params.hostURL) {
      await this.store.setHostID(params.hostID);
      await this.store.setHostURL(params.hostURL);
    } else if (params.hostURL) {
      await this.register(params.hostURL);
    } else {
      await this.loadHost();
    }
    this.emitUpdate();

    if (this.hostURL) {
      await this.connect(this.hostURL);
      this.emitUpdate();
    }

    await this.sync();
    this.emitXferUpdate();
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
    this.emitUpdate();
  }

  async loadHost() {
    if (!this.seed) {
      return;
    }
    const hostURL = await this.store.getHostURL();
    if (!hostURL) {
      return;
    }
    const hostID = (await this.store.getHostID()) || hostURL;
    this.hostURL = new URL(hostURL);
    this.hostKeyPair = await libsodiumCrypto.deriveEd25519KeyPair(
      this.seed,
      hostID,
    );
  }

  // TODO: dedupe with loadHost.
  async register(hostURL: string) {
    if (!this.seed) {
      return;
    }
    this.hostURL = new URL(hostURL);
    const hostID = hostURL;
    this.hostKeyPair = await libsodiumCrypto.deriveEd25519KeyPair(
      this.seed,
      hostID,
    );
    await webClientAPI.register(
      this.hostURL,
      this.hostKeyPair.publicKey,
      "tok123",
    );

    await this.store.setLastFetchedAt(new Date(0));
    await this.store.setHostURL(hostURL);
    await this.store.setHostID(hostID);

    this.emitUpdate();
  }

  disconnect = () => {
    this.hostURL = undefined;
    this.hostKeyPair = undefined;
    this.websocketManager.disconnect();
  };

  async registerAndConnect(hostURL: string) {
    await this.register(hostURL);
    await this.connect(new URL(hostURL));
    await this.requeueAllOpsForUpload();
    await this.sync();
  }

  async requeueAllOpsForUpload() {
    for (const op of await this.store.listOps()) {
      await this.store.enqueueUpload(htob(op.sha256), op.cipherOp);
    }
  }

  async emitUpdate() {
    const state = await this.getState();
    this.stateEmitter.emit("update", state);
  }

  async emitXferUpdate() {
    const state = await this.getXferState();
    this.xferStateEmitter.emit("update", state);
  }

  async getState(): Promise<IDiplomaticClientState> {
    const hasSeed = this.seed !== undefined && this.encKey !== undefined;
    const hasHost = this.hostURL !== undefined &&
      this.hostKeyPair !== undefined;
    const connected = this.websocketManager.isConnected();
    return { hasSeed, hasHost, connected };
  }

  async getXferState(): Promise<IDiplomaticClientXferState> {
    const numUploads = await this.store.numUploads();
    const numDownloads = await this.store.numDownloads();
    return { numDownloads, numUploads };
  }

  async processOps() {
    await this.pullOpPaths();
    await this.fetchAndExecQueuedOps();
  }

  async pullOpPaths() {
    if (!this.hostURL || !this.hostKeyPair || !this.encKey) {
      return [];
    }
    const lastFetchedAt = await this.store.getLastFetchedAt();
    const begin = lastFetchedAt ?? new Date(0);
    // const begin = lastFetchedAt ?? new Date(0);
    const { hostURL, hostKeyPair } = this;
    const resp = await webClientAPI.listDeltas(hostURL, begin, hostKeyPair);
    for (const item of resp.deltas) {
      await this.store.dequeueUpload(item.sha256); // In case e.g. user did a local file import.
      if (await this.store.hasOp(item.sha256)) {
        continue;
      }
      await this.store.enqueueDownload(item.sha256, item.recordedAt);
      this.emitXferUpdate();
    }
    // NOTE: do not update lastFetchedAt until all paths are safely enqueued for download.
    // Advancing lastFetchedAt prematurely could cause a path to be missed, causing out-of-sync (OOS).
    await this.store.setLastFetchedAt(new Date(resp.fetchedAt));
  }

  async fetchAndExecQueuedOps() {
    if (!this.hostURL || !this.hostKeyPair || !this.encKey) {
      return [];
    }
    const { hostURL, hostKeyPair, encKey } = this;
    // TODO: parallelize in web worker.
    const items = await this.store.listDownloads();
    // paths.sort((p1, p2) => p2.localeCompare(p1)); // Sort descending.
    items.sort((i1, i2) => i1.recordedAt.getTime() - i2.recordedAt.getTime()); // Sort ascending.
    for (const item of items) {
      if (await this.store.hasOp(item.sha256)) {
        // Skip.
        await this.store.dequeueDownload(item.sha256);
        this.emitXferUpdate();
        continue;
      }
      try {
        const cipher = await webClientAPI.getDelta(
          hostURL,
          item.sha256,
          hostKeyPair,
        );
        const packed = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
          cipher,
          encKey,
        );
        const op = decode(packed) as IOp;
        const sha256 = await libsodiumCrypto.sha256Hash(cipher);
        await this.stateManager.apply(op);
        await this.store.storeOp(sha256, cipher);
        await this.store.dequeueDownload(sha256);
        this.emitXferUpdate();
      } catch (err) {
        console.error("Processing download", err, item);

        let transient = true;
        if (
          err instanceof Error &&
          err.message === "wrong secret key for the given ciphertext"
        ) {
          // No coming back from this one.
          // Display to user somehow?
          transient = false;
        }

        if (!transient) {
          await this.store.dequeueDownload(item.sha256);
          this.emitXferUpdate();
          // Also put it on a "dead" queue to record the permanent failure?
        }
      }
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
    this.emitXferUpdate();
  }

  async pushQueuedOps() {
    for (const sha256 of await this.store.listUploads()) {
      await this.pushQueuedOp(sha256);
    }
  }

  async sync() {
    await this.processOps();
    await this.pushQueuedOps();
  }

  async apply(op: IOp) {
    if (!this.encKey) {
      throw "No encryption key";
    }
    // NOTE: DIPLOMATIC *must* ensure the delta is queued before locally executing it.
    // This has the potential to cause lag before UI updates, but the greater evil is to update local state first but fail to queue the delta for sync, causing remote state to never match local.
    const packed = encode(op);
    const cipherOp = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(
      packed,
      this.encKey,
    );
    const sha256 = await libsodiumCrypto.sha256Hash(cipherOp);
    await this.store.enqueueUpload(sha256, cipherOp);
    this.emitXferUpdate();

    try {
      await this.stateManager.apply(op);
      // TODO: just combine this with enqueing an upload.
      await this.store.storeOp(sha256, cipherOp);
    } catch (err) {
      // If op can't be applied locally, don't burden anyone else with it.
      await this.store.dequeueUpload(sha256);
      this.emitXferUpdate();
    }

    try {
      await this.pushQueuedOp(sha256);
    } catch (err) {
      // If this fails, it will remain in the queue to be retried later.
      console.info("failed to push");
    }
  }

  async export(filename: string, extension = "dip") {
    const ops = await this.store.listOps();

    const zip = new JSZip();
    for (const op of ops) {
      zip.file(`${op.sha256}.op`, op.cipherOp);
    }
    const blob = await zip.generateAsync({
      compression: "STORE",
      type: "blob",
    });
    return saveAs(blob, `${filename}.${extension}`);
  }

  import = async (file: File) => {
    if (!this.encKey) {
      return;
    }
    const { encKey } = this;
    const zip = await JSZip.loadAsync(file);
    for (const opFileName of Object.keys(zip.files)) {
      const hex = opFileName.split(".")[0];
      const zipSha256 = htob(hex);
      if (await this.store.hasOp(zipSha256)) {
        continue;
      }
      const cipher = await zip.files[opFileName].async("uint8array");
      const packed = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
        cipher,
        encKey,
      );
      const op = decode(packed) as IOp;
      const sha256 = await libsodiumCrypto.sha256Hash(cipher);
      await this.stateManager.apply(op);
      await this.store.storeOp(sha256, cipher);
      this.emitXferUpdate();
    }
  };

  async upsert<T>({
    type,
    body,
    eid,
    gid,
    pid,
    version = 0,
  }: {
    type: string;
    body: T;
    eid?: EntityID;
    gid?: GroupID;
    pid?: EntityID;
    version?: number;
  }) {
    const id = eid ?? (await libsodiumCrypto.gen128BitRandomID());
    const op = genUpsertOp<T>(id, type, body, version, gid, pid);
    return this.apply(op);
  }

  async delete<T>(type: string, eid: Uint8Array, version = 0) {
    const op = genDeleteOp<T>(eid, type, version);
    return this.apply(op);
  }
}
