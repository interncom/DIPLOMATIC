// Enclave is an abstraction for accessing the master seed.
// The point is to eventually secure the seed with hardware.
// Sensitive key material (seed, derived keys, host private keys) must not leave
// this boundary; callers get only public results (ciphertext, plaintext, etc.).
//
// Ops that need the seed are async so a hardware backend can use IPC. Derived
// cipher handles bind public KDM only and call back into the enclave — they do
// not hold key bytes (hardware can swap in a session handle later).

import type { DerivationSeed, ICrypto, MasterSeed } from "./types.ts";
import { concat } from "./binary.ts";

export type EncryptCipher = {
  encrypt: (data: Uint8Array) => Promise<Uint8Array>;
};

export type DecryptCipher = {
  decrypt: (data: Uint8Array) => Promise<Uint8Array>;
};

/** Encrypt + decrypt capability for one KDM. */
export type DerivedCipher = EncryptCipher & DecryptCipher;

/** Which ops the caller needs; only those methods are present on the handle. */
export type CipherUsage = "encrypt" | "decrypt" | "both";

/** Return shape of `deriveCipher` for a given usage (type-level enforcement). */
export type CipherForUsage<U extends CipherUsage> = {
  encrypt: EncryptCipher;
  decrypt: DecryptCipher;
  both: DerivedCipher;
}[U];

export class Enclave {
  #seed: MasterSeed;
  #crypto: ICrypto;

  constructor(seed: MasterSeed, crypto: ICrypto) {
    this.#seed = seed;
    this.#crypto = crypto;
  }

  /**
   * Cipher for public KDM. Does not hold key bytes; each op re-enters the
   * enclave (async, hardware-shaped). `usage` selects the return shape:
   * `"encrypt"` → `{ encrypt }`, `"decrypt"` → `{ decrypt }`, `"both"` → both.
   */
  deriveCipher<U extends CipherUsage>(
    kdm: Uint8Array,
    usage: U,
  ): CipherForUsage<U> {
    const kdmBound = kdm.slice();
    const encrypt = (data: Uint8Array) => this.#encrypt(kdmBound, data);
    const decrypt = (data: Uint8Array) => this.#decrypt(kdmBound, data);
    // Freeze so callers cannot reassign encrypt/decrypt on a shared handle.
    const byUsage: { [K in CipherUsage]: CipherForUsage<K> } = {
      encrypt: Object.freeze({ encrypt }),
      decrypt: Object.freeze({ decrypt }),
      both: Object.freeze({ encrypt, decrypt }),
    };
    return byUsage[usage];
  }

  async #encrypt(kdm: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const key = await this.#keyFromKDM(kdm);
    return this.#crypto.encryptXSalsa20Poly1305Combined(data, key);
  }

  async #decrypt(kdm: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const key = await this.#keyFromKDM(kdm);
    return this.#crypto.decryptXSalsa20Poly1305Combined(data, key);
  }

  async #keyFromKDM(kdm: Uint8Array): Promise<Uint8Array> {
    return this.#crypto.blake3(concat(this.#seed, kdm));
  }

  /**
   * @deprecated Prefer deriveCipher. Returns raw key material; will become
   * private once all callers are moved inside the enclave.
   */
  async deriveFromKDM(kdm: Uint8Array): Promise<DerivationSeed> {
    return (await this.#keyFromKDM(kdm)) as Uint8Array as DerivationSeed;
  }

  /**
   * @deprecated Host key derivation will move inside the enclave.
   * Returns raw key material that must not leave the enclave long-term.
   */
  async derive(keyPath: string, idx = 0): Promise<DerivationSeed> {
    const keyPathBytes = new TextEncoder().encode(keyPath);
    const indexBytes = new Uint8Array(8);
    new DataView(indexBytes.buffer).setBigUint64(0, BigInt(idx), false);
    const kdm = concat(keyPathBytes, indexBytes);
    return await this.deriveFromKDM(kdm);
  }
}
