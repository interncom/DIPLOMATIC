// Enclave is the sole long-lived holder of the master seed — a one-way door.
//
// IRON LAW — never break these:
//   1. Never return unencrypted seed (or seed-bearing plaintext wire) to callers.
//   2. Never accept a callback/function that is invoked with unencrypted seed.
//   3. If an operation needs the seed (largeBlob persist, pair-package AEAD, …),
//      that entire operation lives on Enclave (or is static and returns only
//      Enclave / ciphertext / Status). Move the call site into this boundary;
//      do not export a "handle seed data" helper for outer layers.
//
// Callers may receive only: derived public handles (Identity, ciphers), AEAD
// ciphertext, Status/booleans, and new Enclave instances from factories.
//
// Browser WebAuthn I/O (largeBlob, PRF) lives in shared/webauthn; Enclave only
// encodes/decodes seed and calls those fixed modules. PRF bytes never leave
// Enclave methods — sealed ciphertext on disk is not secret without a ceremony
// Enclave itself initiates.
//
// Transient secrets (PRF, wrap/pair KEK, derivation seed, Ed25519 priv) are
// fill(0)'d before return. JS cannot OPENSSL_cleanse, but an uncleared buffer
// is a standing copy a heap dump can steal without another UV.

import { concat } from "../binary.ts";
import { Decoder, Encoder } from "../codec.ts";
import {
  createIdentityBundle,
  identityBundleCodec,
} from "../codecs/identityBundle.ts";
import type { BundleHost } from "../codecs/bundleHost.ts";
import {
  type PairPackagePlain,
  pairPackagePlainCodec,
} from "../codecs/pairPackage.ts";
import { kdmBytes, Status } from "../consts.ts";
import {
  asMasterSeed,
  asSealedMasterKey,
  MASTER_SEED_LEN,
  type MasterSeed,
  type SealedMasterKey,
} from "../seed.ts";
import type { DerivationSeed, ICrypto, KeyPair, PublicKey } from "../types.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { NobleCrypto } from "./noble.ts";
import {
  asDHKEResp,
  type DHKEReq,
  type DHKEResp,
  pairKey,
  PairRequest,
} from "./pairing.ts";
import type { X25519Sk } from "./x25519.ts";
import {
  largeBlobCreateCred,
  type LargeBlobCreateOpts,
  largeBlobRead,
  type LargeBlobRp,
  largeBlobWrite,
} from "../webauthn/largeBlob.ts";
import {
  createPrfCred,
  DEFAULT_PRF_SALT,
  evalPrf,
  type PrfCreateOpts,
  type PrfEvalOpts,
  type PrfRp,
} from "../webauthn/prf.ts";
import {
  postToDiplomaticWorker,
  spawnDiplomaticSyncWorker,
} from "../worker/spawn.ts";

export type { LargeBlobCreateOpts, LargeBlobRp };
export type { PrfCreateOpts, PrfEvalOpts, PrfRp };

/** Options for PRF seal/unseal ceremonies (no raw PRF bytes). */
export type PasskeyPrfOpts = PrfRp & {
  salt?: Uint8Array;
  credId?: Uint8Array;
  /** Seal only: create a PRF credential first when no credId is known. */
  createCredIfNeeded?: boolean;
  userName?: string;
};

/** Durable PRF-sealed master + public meta (never includes PRF output). */
export type PrfSealedMaster = {
  sealedMaster: SealedMasterKey;
  salt: Uint8Array;
  credId: Uint8Array;
};

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

const SEAL_WRAP_DOMAIN = new TextEncoder().encode("diplomatic.wrap.v1");
const SEAL_KEY_LEN = 32;
const SEAL_PRF_MIN_LEN = 16;

// Bound at load — not an Enclave constructor argument (no caller ICrypto).
const noble = new NobleCrypto();

export class Enclave {
  #seed: MasterSeed;

  private constructor(seed: MasterSeed) {
    this.#seed = seed;
  }

  /** New enclave with a fresh 32-byte master seed. */
  static async fromRandom(): Promise<Enclave> {
    const bytes = await noble.gen256BitSecureRandomSeed();
    const [seed, st] = asMasterSeed(bytes);
    if (st !== Status.Success || seed === undefined) {
      throw new Error(`enclave: invalid random seed (${st})`);
    }
    return new Enclave(seed);
  }

  /**
   * Construct from raw master seed bytes (import / bootstrap only).
   * Copies the seed so callers may zero their buffer after success.
   * Prefer {@link fromRandom} or {@link unsealWithPasskey} for normal flows.
   */
  static fromBytes(bytes: Uint8Array): ValStat<Enclave> {
    const [seed, st] = asMasterSeed(bytes);
    if (st !== Status.Success) return err(st);
    if (seed === undefined) return err(Status.InvalidParam);
    const [owned, ost] = asMasterSeed(seed.slice());
    if (ost !== Status.Success) return err(ost);
    if (owned === undefined) return err(Status.InvalidParam);
    return ok(new Enclave(owned));
  }

  /**
   * UV + PRF ceremony, then AEAD-seal master. Returns sealed ciphertext + public
   * meta only — never PRF output. Sealed blob on disk is useless without a
   * ceremony Enclave itself runs on unlock.
   *
   * Future: sealWithPassphrase when PRF is unavailable (same sealed layout).
   */
  async sealWithPasskey(
    opts?: PasskeyPrfOpts,
  ): Promise<ValStat<PrfSealedMaster>> {
    const salt = opts?.salt ?? DEFAULT_PRF_SALT;
    let credId = opts?.credId;

    if (credId === undefined && opts?.createCredIfNeeded === true) {
      const [created, cst] = await createPrfCred({
        rpId: opts?.rpId,
        rpName: opts?.rpName,
        userName: opts?.userName ?? "diplomatic-prf",
      });
      if (cst !== Status.Success) return err(cst);
      if (created === undefined) return err(Status.HostError);
      if (!created.prfEnabled) return err(Status.HostError);
      credId = created.credId;
    }

    const [ev, est] = await evalPrf({
      rpId: opts?.rpId,
      rpName: opts?.rpName,
      credId,
      salt,
    });
    if (est !== Status.Success) return err(est);
    if (ev === undefined) return err(Status.MissingBody);

    try {
      const [sealedMaster, sst] = await this.#sealUnderPrf(ev.prf);
      if (sst !== Status.Success) return err(sst);
      if (sealedMaster === undefined) return err(Status.InternalError);
      return ok({
        sealedMaster,
        salt: salt.slice(),
        credId: ev.credId.slice(),
      });
    } finally {
      // hmac-secret output is IKM; must not sit next to sealedMaster in the heap.
      ev.prf.fill(0);
    }
  }

  /**
   * UV + PRF ceremony, then unseal durable master into a new Enclave.
   * Callers never supply PRF bytes — only sealed meta + RP/salt/credId.
   * Returns the credential id used so stores can persist it (skip picker next time).
   */
  static async unsealWithPasskey(
    sealedMaster: SealedMasterKey,
    opts: PasskeyPrfOpts & { salt: Uint8Array },
  ): Promise<ValStat<{ enclave: Enclave; credId: Uint8Array }>> {
    const [ev, est] = await evalPrf({
      rpId: opts.rpId,
      rpName: opts.rpName,
      credId: opts.credId,
      salt: opts.salt,
    });
    if (est !== Status.Success) return err(est);
    if (ev === undefined) return err(Status.MissingBody);
    try {
      const [enclave, ust] = await Enclave.#unsealUnderPrf(
        sealedMaster,
        ev.prf,
      );
      if (ust !== Status.Success) return err(ust);
      if (enclave === undefined) return err(Status.InternalError);
      return ok({ enclave, credId: ev.credId.slice() });
    } finally {
      ev.prf.fill(0);
    }
  }

  /**
   * UV + write IdentityBundle (seed + hosts) to largeBlob.
   * Encode and WebAuthn write complete inside this method; nothing seed-bearing
   * is returned. Prefer empty `hosts` for seed-only backup.
   *
   * Pass `opts.credId` to write an existing credential (one UV). Omit it to
   * create a largeBlob-capable credential then write (two UV). Returns the
   * credential id used.
   */
  async persistToLargeBlob(
    hosts: BundleHost[] = [],
    opts?: LargeBlobCreateOpts & { credId?: Uint8Array },
  ): Promise<ValStat<Uint8Array>> {
    let credId = opts?.credId;
    if (credId === undefined) {
      const [created, cst] = await largeBlobCreateCred(opts);
      if (cst !== Status.Success) return err(cst);
      if (created === undefined) return err(Status.HostError);
      credId = created;
    }

    const [encoded, est] = this.#encodeIdentityBundleWire(hosts);
    if (est !== Status.Success) return err(est);
    if (encoded === undefined) return err(Status.InternalError);
    try {
      const wst = await largeBlobWrite(credId, encoded, opts);
      if (wst !== Status.Success) return err(wst);
      return ok(credId);
    } finally {
      encoded.fill(0);
    }
  }

  /**
   * UV + read largeBlob payload into a new Enclave (+ hosts if IdentityBundle).
   * Seed material never leaves this factory.
   *
   * Pass `opts.credId` for a known credential; omit for discoverable assertion.
   * Returns the credential id used (useful after discover).
   */
  static async fromLargeBlob(
    opts?: LargeBlobRp & { credId?: Uint8Array },
  ): Promise<
    ValStat<{ enclave: Enclave; hosts: BundleHost[]; credId: Uint8Array }>
  > {
    const [raw, rst] = await largeBlobRead(opts?.credId, opts);
    if (rst !== Status.Success) return err(rst);
    if (raw === undefined) return err(Status.MissingBody);
    try {
      return Enclave.#enclaveFromLargeBlobPayload(
        raw.blob,
        raw.credId,
      );
    } finally {
      raw.blob.fill(0);
    }
  }

  /** UV + overwrite largeBlob with zeros (destroys stored seed material). */
  static async clearLargeBlob(
    credId: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<Status> {
    return largeBlobWrite(credId, new Uint8Array(MASTER_SEED_LEN), opts);
  }

  // Starts an enrollee pairing session (same as PairRequest.create).
  static pairRequest(): Promise<ValStat<PairRequest>> {
    return PairRequest.create();
  }

  // Seals this enclave's seed + hosts for the enrollee's DHKE request.
  // Returns dhkeResp to send back.
  async pairAccept(
    dhkeReq: DHKEReq,
    hosts: BundleHost[],
  ): Promise<ValStat<DHKEResp>> {
    let eph: { priv: X25519Sk; pub: Uint8Array }; // ephemeral X25519 pair
    try {
      eph = await noble.genX25519();
    } catch {
      return err(Status.CryptoError);
    }
    try {
      const [key, kst] = await pairKey(eph.priv, dhkeReq, dhkeReq, eph.pub);
      if (kst !== Status.Success) return err(kst);
      if (key === undefined) return err(Status.InternalError);
      try {
        const [plainBytes, pst] = this.#encodePairPlain(hosts);
        if (pst !== Status.Success) return err(pst);
        if (plainBytes === undefined) return err(Status.InternalError);
        try {
          const body = await noble.encryptXSalsa20Poly1305Combined(
            plainBytes,
            key,
          );
          return asDHKEResp(concat(eph.pub, body));
        } catch {
          return err(Status.InternalError);
        } finally {
          plainBytes.fill(0);
        }
      } finally {
        key.fill(0);
      }
    } finally {
      eph.priv.fill(0);
    }
  }

  // Encodes seed + hosts as pairing AEAD plaintext.
  #encodePairPlain(hosts: BundleHost[]): ValStat<Uint8Array> {
    const raw = this.#seed.slice();
    const [snap, sst] = asMasterSeed(raw); // copy to wipe after encode
    if (snap === undefined) {
      raw.fill(0);
      return err(sst);
    }
    try {
      const plain: PairPackagePlain = {
        masterSeed: snap,
        hosts: hosts.map((h) => ({
          handle: h.handle,
          label: h.label,
          idx: h.idx ?? 0,
        })),
      };
      const enc = new Encoder();
      const wst = enc.writeStruct(pairPackagePlainCodec, plain);
      if (wst !== Status.Success) return err(wst);
      return ok(enc.result());
    } finally {
      snap.fill(0);
    }
  }

  /**
   * Spawn a new sync Worker from the embedded bundle and inject this enclave's
   * master seed into it (transfer). Seed never goes to a caller-supplied port —
   * only to a worker this method just created.
   *
   * Returns the Worker. Caller (WorkerClient) should adopt it and await the
   * `setSeed` reply for `opts.id`.
   */
  spawnSyncWorker(opts: { id: number; persist?: boolean }): Worker {
    const worker = spawnDiplomaticSyncWorker();
    const seed = this.#seed.slice();
    postToDiplomaticWorker(
      worker,
      {
        id: opts.id,
        op: "setSeed",
        seed,
        persist: opts.persist,
      },
      [seed.buffer],
    );
    return worker;
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
    const publicKey = keys.publicKey;
    // Handle only needs the pub; priv would outlive this call on the Identity.
    keys.privateKey.fill(0);
    return Object.freeze({
      publicKey,
      sign: (message: Uint8Array | string) => this.#sign(path, index, message),
      kdmFor: (msgHeadEnc: Uint8Array) => this.#kdmFor(path, index, msgHeadEnc),
    });
  }

  /** AEAD-seal master under KDF(PRF). PRF must stay inside Enclave methods. */
  async #sealUnderPrf(prf: Uint8Array): Promise<ValStat<SealedMasterKey>> {
    const [key, kst] = await sealKeyFromPrf(noble, prf);
    if (kst !== Status.Success) return err(kst);
    if (key === undefined) return err(Status.InternalError);
    try {
      const sealed = await noble.encryptXSalsa20Poly1305Combined(
        this.#seed,
        key,
      );
      return asSealedMasterKey(sealed);
    } catch {
      return err(Status.InternalError);
    } finally {
      // Wrap KEK decrypts durable master; do not leave it after seal.
      key.fill(0);
    }
  }

  static async #unsealUnderPrf(
    sealed: SealedMasterKey,
    prf: Uint8Array,
  ): Promise<ValStat<Enclave>> {
    const [, sst] = asSealedMasterKey(sealed);
    if (sst !== Status.Success) return err(sst);
    const [key, kst] = await sealKeyFromPrf(noble, prf);
    if (kst !== Status.Success) return err(kst);
    if (key === undefined) return err(Status.InternalError);
    let plain: Uint8Array | undefined;
    try {
      try {
        plain = await noble.decryptXSalsa20Poly1305Combined(sealed, key);
      } catch {
        return err(Status.DecryptionError);
      }
      // fromBytes copies; wipe the decrypt buffer so two seed copies do not remain.
      return Enclave.fromBytes(plain);
    } finally {
      key.fill(0);
      plain?.fill(0);
    }
  }

  /**
   * Private: IdentityBundle wire for largeBlob I/O only.
   * Never expose this buffer outside Enclave methods.
   */
  #encodeIdentityBundleWire(hosts: BundleHost[]): ValStat<Uint8Array> {
    const raw = this.#seed.slice();
    const [snap, sst] = asMasterSeed(raw); // copy to wipe after encode
    if (snap === undefined) {
      raw.fill(0);
      return err(sst);
    }
    try {
      const [bundle, bst] = createIdentityBundle(snap, hosts);
      if (bst !== Status.Success) return err(bst);
      if (bundle === undefined) return err(Status.InternalError);
      try {
        const enc = new Encoder();
        const st = enc.writeStruct(identityBundleCodec, bundle);
        if (st !== Status.Success) return err(st);
        return ok(enc.result());
      } finally {
        bundle.masterSeed.fill(0);
      }
    } finally {
      snap.fill(0);
    }
  }

  /**
   * Private: absorb largeBlob payload (legacy 32-byte seed or IdentityBundle).
   */
  static #enclaveFromLargeBlobPayload(
    seedBytes: Uint8Array,
    credId: Uint8Array,
  ): ValStat<{ enclave: Enclave; hosts: BundleHost[]; credId: Uint8Array }> {
    if (seedBytes.byteLength === 0 || seedBytes.every((b) => b === 0)) {
      return err(Status.MissingSeed);
    }
    // Legacy format: bare master seed.
    if (seedBytes.byteLength === MASTER_SEED_LEN) {
      if (seedBytes.every((b) => b === 0)) return err(Status.MissingSeed);
      const [enclave, est] = Enclave.fromBytes(seedBytes);
      if (est !== Status.Success) return err(est);
      if (enclave === undefined) return err(Status.InternalError);
      return ok({ enclave, hosts: [], credId });
    }
    const dec = new Decoder(seedBytes);
    const [bundle, bst] = dec.readStruct(identityBundleCodec);
    if (bst !== Status.Success) return err(bst);
    if (bundle === undefined) return err(Status.InvalidMessage);
    try {
      // All-zero master (e.g. pre-fix write that zeroed seed while encoding).
      if (bundle.masterSeed.every((b) => b === 0)) {
        return err(Status.MissingSeed);
      }
      const [enclave, est] = Enclave.fromBytes(bundle.masterSeed);
      if (est !== Status.Success) return err(est);
      if (enclave === undefined) return err(Status.InternalError);
      return ok({
        enclave,
        hosts: bundle.hosts.map((h) => ({ ...h })),
        credId,
      });
    } finally {
      bundle.masterSeed.fill(0);
    }
  }

  async #encrypt(kdm: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const key = await this.#keyFromKDM(kdm);
    try {
      return await noble.encryptXSalsa20Poly1305Combined(data, key);
    } finally {
      key.fill(0);
    }
  }

  async #decrypt(kdm: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const key = await this.#keyFromKDM(kdm);
    try {
      return await noble.decryptXSalsa20Poly1305Combined(data, key);
    } finally {
      key.fill(0);
    }
  }

  async #keyFromKDM(kdm: Uint8Array): Promise<Uint8Array> {
    return noble.blake3(concat(this.#seed, kdm));
  }

  async #deriveSeed(keyPath: string, idx: number): Promise<DerivationSeed> {
    const keyPathBytes = new TextEncoder().encode(keyPath);
    const indexBytes = new Uint8Array(8);
    new DataView(indexBytes.buffer).setBigUint64(0, BigInt(idx), false);
    const seed = await this.#keyFromKDM(concat(keyPathBytes, indexBytes));
    return seed as Uint8Array as DerivationSeed;
  }

  async #deriveSubkeys(keyPath: string, idx: number): Promise<KeyPair> {
    const seed = await this.#deriveSeed(keyPath, idx);
    try {
      return await noble.deriveEd25519KeyPair(seed);
    } finally {
      // Pair already holds seed‖pub; this 32-byte deriv must not linger.
      seed.fill(0);
    }
  }

  async #sign(
    keyPath: string,
    idx: number,
    message: Uint8Array | string,
  ): Promise<Uint8Array> {
    const keys = await this.#deriveSubkeys(keyPath, idx);
    try {
      return await noble.signEd25519(message, keys.privateKey);
    } finally {
      // Re-derived per sign so the caller never holds a long-lived priv.
      keys.privateKey.fill(0);
    }
  }

  async #kdmFor(
    keyPath: string,
    idx: number,
    msgHeadEnc: Uint8Array,
  ): Promise<Uint8Array> {
    const keys = await this.#deriveSubkeys(keyPath, idx);
    const kdmSource = concat(keys.privateKey, msgHeadEnc);
    // concat copied priv; wipe the source first so only kdmSource remains.
    keys.privateKey.fill(0);
    try {
      const kdmHash = await noble.blake3(kdmSource);
      return kdmHash.slice(0, kdmBytes);
    } finally {
      kdmSource.fill(0);
    }
  }
}

/** Derive seal key from PRF output (domain-separated). Used by enclave seal/unseal. */
export async function sealKeyFromPrf(
  crypto: ICrypto,
  prf: Uint8Array,
  domain: Uint8Array = SEAL_WRAP_DOMAIN,
): Promise<ValStat<Uint8Array>> {
  if (prf.byteLength < SEAL_PRF_MIN_LEN) return err(Status.InvalidParam);
  const hash = await crypto.blake3(concat(prf, domain));
  return ok(hash.slice(0, SEAL_KEY_LEN));
}

export { MASTER_SEED_LEN, SEAL_KEY_LEN, SEAL_PRF_MIN_LEN, SEAL_WRAP_DOMAIN };
