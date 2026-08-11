// Protocol IDB seed meta: session Enclave (memory) + sealed durable meta.
// Never stores raw master seed / plain hex. Legacy "seed" hex rows are absorbed
// once into an Enclave on load, then deleted (migration).
//
// Durable forms today: PRF-sealed master (K_PRF_META via openPrfStore).
// Future fallback when PRF is unavailable: passphrase-sealed master (same
// SealedMasterKey AEAD, key from KDF(passphrase, salt)) in a parallel meta
// row — unlock prompts for passphrase, then Enclave.unseal*; still no plain seed.

import { Enclave } from "../../shared/crypto/enclave";
import { Status } from "../../shared/consts";
import { asSealedMasterKey } from "../../shared/seed";
import type { ICrypto } from "../../shared/types";
import { htob } from "../../shared/binary";
import type { ISeedStore, SetSeedOpts } from "../../types";
import {
  PrfSeedStore,
  type PrfSeedMeta,
  type PrfSeedStoreOpts,
} from "../../passkey/prf-store";
import { SEED_META_TABLE } from "./store";

/** @deprecated legacy plain-hex key — read once for migration, never written. */
const K_SEED_HEX = "seed";
const K_PRF_META = "prfMeta";

type StoredPrfMeta = {
  sealedMaster: Uint8Array;
  salt: Uint8Array;
  credId?: Uint8Array;
};

export class IDBSeedStore implements ISeedStore {
  enclave?: Enclave;
  db: IDBDatabase;
  #crypto: ICrypto;

  constructor(db: IDBDatabase, crypto: ICrypto) {
    this.db = db;
    this.#crypto = crypto;
  }

  /**
   * Hold enclave in memory only. Durable identity is sealed meta
   * ({@link openPrfStore} / {@link persistPrfMeta}), never plain seed.
   * `opts.persist` is ignored (kept for API compatibility).
   *
   * TODO(passphrase): when PRF is missing, `persist: true` (or a dedicated
   * wrap API) should seal under a passphrase KDF and write sealed meta here —
   * same shape as prfMeta, not a return of raw seed.
   */
  async save(enclave: Enclave, _opts?: SetSeedOpts) {
    this.enclave = enclave;
    return this.enclave;
  }

  async load() {
    if (this.enclave) {
      return this.enclave;
    }
    // One-time migration: absorb legacy plain-hex row into enclave, then scrub.
    const hex = await this.#loadLegacyHex();
    if (hex === undefined || hex === "") {
      return undefined;
    }
    const bytes = htob(hex);
    const [enclave, st] = Enclave.fromBytes(this.#crypto, bytes);
    bytes.fill(0);
    await this.#deleteLegacyHex();
    if (st !== Status.Success || enclave === undefined) {
      return undefined;
    }
    this.enclave = enclave;
    return this.enclave;
  }

  /**
   * Drop in-memory enclave and any leftover legacy hex. Keeps {@link K_PRF_META}
   * so daily unlock via PRF still works after a soft lock.
   */
  async clearSession() {
    this.enclave = undefined;
    await this.#deleteLegacyHex();
  }

  async wipe() {
    this.enclave = undefined;
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete(K_SEED_HEX);
      store.delete(K_PRF_META);
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

  #loadLegacyHex(): Promise<string | undefined> {
    const tx = this.db.transaction(SEED_META_TABLE, "readonly");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.get(K_SEED_HEX);
      req.onsuccess = () => {
        const v = req.result;
        resolve(typeof v === "string" && v.length > 0 ? v : undefined);
      };
      req.onerror = () => reject(req.error);
    });
  }

  #deleteLegacyHex(): Promise<void> {
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete(K_SEED_HEX);
    });
  }
}

function decodeStoredPrfMeta(raw: unknown): PrfSeedMeta | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Partial<StoredPrfMeta>;
  if (!(o.sealedMaster instanceof Uint8Array) || !(o.salt instanceof Uint8Array)) {
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
