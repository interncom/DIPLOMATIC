// Enclave is an abstraction for accessing the master seed.
// The point is to eventually secure the seed with hardware.
// Sensitive key material (seed, derived keys, host private keys) must not leave
// this boundary; callers get only public results (ciphertext, plaintext, etc.).
//
// Ops that need the seed are async so a hardware backend can use IPC. Derived
// handles bind public inputs only and call back into the enclave — they do not
// hold key bytes (hardware can swap in a session handle later).

import { concat } from "./binary.ts";
import { kdmBytes } from "./consts.ts";
import type {
  DerivationSeed,
  ICrypto,
  KeyPair,
  MasterSeed,
  PublicKey,
} from "./types.ts";

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

/**
 * Path-scoped signing identity: public key is public; sign/kdmFor re-enter
 * the enclave so the private key never leaves. Used for hosts, export files, etc.
 */
export type Identity = {
  readonly publicKey: PublicKey;
  sign: (message: Uint8Array | string) => Promise<Uint8Array>;
  /** Per-bag KDM mixed with this identity's private key (see bag seal). */
  kdmFor: (msgHeadEnc: Uint8Array) => Promise<Uint8Array>;
};

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

  /**
   * Path-scoped identity (label+index). Private key stays in the enclave; only
   * publicKey and capability methods are returned (frozen).
   */
  async deriveIdentity(keyPath: string, idx = 0): Promise<Identity> {
    const path = keyPath;
    const index = idx;
    const keys = await this.#deriveSubkeys(path, index);
    return Object.freeze({
      publicKey: keys.publicKey,
      sign: (message: Uint8Array | string) => this.#sign(path, index, message),
      kdmFor: (msgHeadEnc: Uint8Array) => this.#kdmFor(path, index, msgHeadEnc),
    });
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

  /** Deterministic seed for a path+index under the master seed. */
  async #deriveSeed(keyPath: string, idx: number): Promise<DerivationSeed> {
    const keyPathBytes = new TextEncoder().encode(keyPath);
    const indexBytes = new Uint8Array(8);
    new DataView(indexBytes.buffer).setBigUint64(0, BigInt(idx), false);
    const seed = await this.#keyFromKDM(concat(keyPathBytes, indexBytes));
    return seed as Uint8Array as DerivationSeed;
  }

  /** Ed25519 keypair for a path+index (private material stays in-enclave). */
  async #deriveSubkeys(keyPath: string, idx: number): Promise<KeyPair> {
    const seed = await this.#deriveSeed(keyPath, idx);
    return this.#crypto.deriveEd25519KeyPair(seed);
  }

  async #sign(
    keyPath: string,
    idx: number,
    message: Uint8Array | string,
  ): Promise<Uint8Array> {
    const keys = await this.#deriveSubkeys(keyPath, idx);
    return this.#crypto.signEd25519(message, keys.privateKey);
  }

  async #kdmFor(
    keyPath: string,
    idx: number,
    msgHeadEnc: Uint8Array,
  ): Promise<Uint8Array> {
    // 1. Different key per bag so cracking one does not compromise all.
    // 2. KDM from plaintext head prevents forging arbitrary bags if a key leaks.
    // 3. Identity private key mix prevents the same KDM across paths/hosts.
    const keys = await this.#deriveSubkeys(keyPath, idx);
    const kdmSource = concat(keys.privateKey, msgHeadEnc);
    const kdmHash = await this.#crypto.blake3(kdmSource);
    return kdmHash.slice(0, kdmBytes);
  }
}
