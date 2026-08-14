// Protocol IDB seed meta: session Enclave (memory) + sealed durable meta.
// Never stores raw master seed.
//
// Durable forms today: PRF-sealed master (K_PRF_META via openPrfStore).
// Identity pin (K_ID_PIN): nonce + blake3(nonce ‖ pinPub) so setSeed / largeBlob
// restore cannot switch masters under local data without storing host pubkeys.
// Future fallback when PRF is unavailable: passphrase-sealed master (same
// SealedMasterKey AEAD, key from KDF(passphrase, salt)) in a parallel meta
// row — unlock prompts for passphrase, then Enclave.unseal*; still no plain seed.

import { Enclave } from "../../shared/crypto/enclave";
import { Status } from "../../shared/consts";
import { asSealedMasterKey } from "../../shared/seed";
import type { ICrypto } from "../../shared/types";
import type { ISeedStore, SetSeedOpts } from "../../types";
import {
  type PrfSeedMeta,
  PrfSeedStore,
  type PrfSeedStoreOpts,
} from "../../passkey/prf-store";
import {
  cloneIdPin,
  decodeIdPin,
  type IdPin,
  idPinMatches,
  makeIdPin,
} from "../identityPin";
import { SEED_META_TABLE } from "./store";

const K_PRF_META = "prfMeta";
/** Nonce + hash pin — see {@link IdPin}. */
const K_ID_PIN = "idPin";
/** @deprecated short-lived raw pinPub; deleted if present. */
const K_ID_PUB_LEGACY = "idPub";

type StoredPrfMeta = {
  sealedMaster: Uint8Array;
  salt: Uint8Array;
  credId?: Uint8Array;
};

export class IDBSeedStore implements ISeedStore {
  #enclave?: Enclave;
  db: IDBDatabase;
  #crypto: ICrypto;

  constructor(db: IDBDatabase, crypto: ICrypto) {
    this.db = db;
    this.#crypto = crypto;
  }

  /**
   * Hold enclave in memory only. Durable identity is sealed meta
   * ({@link openPrfStore} / {@link persistPrfMeta}), never plain seed.
   * Pins identity (nonce+hash) on first save; later saves must match
   * (largeBlob / PRF unlock cannot switch masters under this DB).
   * `opts.persist` is ignored (kept for API compatibility).
   *
   * TODO(passphrase): when PRF is missing, `persist: true` (or a dedicated
   * wrap API) should seal under a passphrase KDF and write sealed meta here —
   * same shape as prfMeta, not a return of raw seed.
   */
  async save(enclave: Enclave, _opts?: SetSeedOpts) {
    await this.#assertAndPinIdentity(enclave);
    this.#enclave = enclave;
    return this.#enclave;
  }

  async load() {
    return this.#enclave;
  }

  /**
   * Drop in-memory enclave. Keeps {@link K_PRF_META} and {@link K_ID_PIN}
   * so unlock / largeBlob restore still match this device.
   */
  async clearSession() {
    this.#enclave = undefined;
  }

  async wipe() {
    this.#enclave = undefined;
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete(K_PRF_META);
      store.delete(K_ID_PIN);
      store.delete(K_ID_PUB_LEGACY);
    });
  }

  async loadPrfMeta(): Promise<PrfSeedMeta | undefined> {
    const tx = this.db.transaction(SEED_META_TABLE, "readonly");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.get(K_PRF_META);
      req.onsuccess = () => {
        resolve(decodeStoredPrfMeta(req.result));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async persistPrfMeta(meta: PrfSeedMeta | undefined): Promise<void> {
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      if (meta === undefined) {
        store.delete(K_PRF_META);
        return;
      }
      const row: StoredPrfMeta = {
        sealedMaster: meta.sealedMaster.slice(),
        salt: meta.salt.slice(),
        credId: meta.credId === undefined ? undefined : meta.credId.slice(),
      };
      store.put(row, K_PRF_META);
    });
  }

  async hasPrfMeta(): Promise<boolean> {
    const m = await this.loadPrfMeta();
    return m !== undefined;
  }

  /** Last PRF passkey id, if this device has a sealed PRF identity. */
  async lastPrfCredId(): Promise<Uint8Array | undefined> {
    const m = await this.loadPrfMeta();
    return m?.credId === undefined ? undefined : m.credId.slice();
  }

  async openPrfStore(
    opts: Omit<PrfSeedStoreOpts, "crypto" | "persistMeta" | "meta"> & {
      crypto?: ICrypto;
    },
  ): Promise<PrfSeedStore> {
    const meta = await this.loadPrfMeta();
    return new PrfSeedStore({
      crypto: opts.crypto ?? this.#crypto,
      rpId: opts.rpId,
      rpName: opts.rpName,
      meta,
      persistMeta: (m) => this.persistPrfMeta(m),
    });
  }

  async #assertAndPinIdentity(enclave: Enclave): Promise<void> {
    // Drop short-lived raw idPub if any (never store host-like pubkeys on disk).
    await this.#deleteKey(K_ID_PUB_LEGACY);
    const prev = await this.#loadIdPin();
    if (prev !== undefined) {
      if (!(await idPinMatches(this.#crypto, enclave, prev))) {
        throw new Error(
          "[DIPLOMATIC] seed does not match this device's identity " +
            "(local data was created with a different master seed)",
        );
      }
      return;
    }
    const pin = await makeIdPin(this.#crypto, enclave);
    await this.#persistIdPin(pin);
  }

  #loadIdPin(): Promise<IdPin | undefined> {
    const tx = this.db.transaction(SEED_META_TABLE, "readonly");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.get(K_ID_PIN);
      req.onsuccess = () => resolve(decodeIdPin(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  #persistIdPin(pin: IdPin): Promise<void> {
    const row = cloneIdPin(pin);
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.put(row, K_ID_PIN);
    });
  }

  #deleteKey(key: string): Promise<void> {
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete(key);
    });
  }
}

function decodeStoredPrfMeta(raw: unknown): PrfSeedMeta | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Partial<StoredPrfMeta>;
  if (
    !(o.sealedMaster instanceof Uint8Array) || !(o.salt instanceof Uint8Array)
  ) {
    return undefined;
  }
  const [sealedMaster, st] = asSealedMasterKey(o.sealedMaster);
  if (st !== Status.Success || sealedMaster === undefined) return undefined;
  return {
    sealedMaster,
    salt: o.salt.slice(),
    credId: o.credId instanceof Uint8Array ? o.credId.slice() : undefined,
  };
}
