// Protocol IDB seed meta: session Enclave (memory) + sealed durable keyring.
// Never stores raw master seed.
//
// Durable forms today: PRF keyring (K_KEYRING via openPrfStore).
// Identity pin (K_ID_PIN): nonce + blake3(nonce ‖ pinPub) so setSeed / largeBlob
// restore cannot switch masters under local data without storing host pubkeys.
// Future fallback when PRF is unavailable: passphrase-sealed master (same
// SealedMasterKey AEAD, key from KDF(passphrase, salt)) in a parallel meta
// row — unlock prompts for passphrase, then Enclave.unseal*; still no plain seed.

import { Enclave } from "../../shared/crypto/enclave";
import type { ICrypto } from "../../shared/types";
import type { ISeedStore, SetSeedOpts } from "../../types";
import {
  cloneKeyring,
  decodeKeyring,
  type Keyring,
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

const K_KEYRING = "keyring";
/** @deprecated pre-0.14 single-binding row; deleted on write/wipe. */
const K_PRF_META = "prfMeta";
/** Nonce + hash pin — see {@link IdPin}. */
const K_ID_PIN = "idPin";
/** @deprecated short-lived raw pinPub; deleted if present. */
const K_ID_PUB_LEGACY = "idPub";

export class IDBSeedStore implements ISeedStore {
  #enclave?: Enclave;
  db: IDBDatabase;
  #crypto: ICrypto;

  constructor(db: IDBDatabase, crypto: ICrypto) {
    this.db = db;
    this.#crypto = crypto;
  }

  /**
   * Hold enclave in memory only. Durable identity is the keyring
   * ({@link openPrfStore} / {@link persistKeyring}), never plain seed.
   * Pins identity (nonce+hash) on first save; later saves must match
   * (largeBlob / PRF unlock cannot switch masters under this DB).
   * `opts.persist` is ignored (kept for API compatibility).
   *
   * TODO(passphrase): when PRF is missing, `persist: true` (or a dedicated
   * bind API) should seal under a passphrase KDF and write sealed meta here —
   * same shape as a keyring entry, not a return of raw seed.
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
   * Drop in-memory enclave. Keeps {@link K_KEYRING} and {@link K_ID_PIN}
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
      store.delete(K_KEYRING);
      store.delete(K_PRF_META);
      store.delete(K_ID_PIN);
      store.delete(K_ID_PUB_LEGACY);
    });
  }

  async loadKeyring(): Promise<Keyring | undefined> {
    const tx = this.db.transaction(SEED_META_TABLE, "readonly");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.get(K_KEYRING);
      req.onsuccess = () => {
        resolve(decodeKeyring(req.result));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async persistKeyring(ring: Keyring | undefined): Promise<void> {
    const tx = this.db.transaction(SEED_META_TABLE, "readwrite");
    const store = tx.objectStore(SEED_META_TABLE);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.delete(K_PRF_META);
      if (ring === undefined) {
        store.delete(K_KEYRING);
        return;
      }
      store.put(cloneKeyring(ring), K_KEYRING);
    });
  }

  async hasKeyring(): Promise<boolean> {
    const r = await this.loadKeyring();
    return r !== undefined && r.entries.length > 0;
  }

  async openPrfStore(
    opts: Omit<PrfSeedStoreOpts, "persistKeyring" | "keyring">,
  ): Promise<PrfSeedStore> {
    const keyring = await this.loadKeyring();
    return new PrfSeedStore({
      rpId: opts.rpId,
      rpName: opts.rpName,
      userName: opts.userName,
      keyring,
      persistKeyring: (r) => this.persistKeyring(r),
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
