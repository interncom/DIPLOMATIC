// Enclave is the sole long-lived holder of the master seed — a one-way door.
// Public methods are locked after the class (non-writable, non-configurable)
// so they cannot be replaced after load.
//
// IRON LAW — never break these:
//   1. Never return unencrypted seed (or seed-bearing plaintext wire) to callers.
//   2. Never accept a callback/function that is invoked with unencrypted seed.
//   3. If an operation needs the seed (largeBlob persist, pair-package AEAD, …),
//      Enclave performs it and returns only Enclave / ciphertext / Status.
//      crypto/largeBlob.ts may receive seed-bearing wire only from Enclave;
//      that handoff is pinned in web/test/enclave.test.ts. sealPair returns
//      the pair key; Enclave encrypts the seed wire. crypto/prf.ts seal and
//      unseal ceremonies return PRF IKM; Enclave seals, unseals, and wipes it.
//      Do not export a seed helper for outer layers.
//
// Callers may receive only: derived public handles (Identity, ciphers), AEAD
// ciphertext, Status/booleans, and new Enclave instances from factories.
//
// dumpToTty (paper): 8×8 hex to /dev/tty, Status only. Fail closed: the write
// runs only when DIP_CLI_DUMP is defined and true. Keep
// `typeof DIP_CLI_DUMP !== "undefined" && DIP_CLI_DUMP` inlined in the method.
// The write itself is crypto/tty.ts, imported only inside that branch so a
// false define drops it. Web/worker/pkg-cli: bun --define DIP_CLI_DUMP=false.
// tools/keys/hexdump re-execs with DIP_CLI_DUMP=true. Missing define →
// NotImplemented.
//
// Browser WebAuthn: largeBlob create/read and PRF capability probe live in
// shared/webauthn. PRF eval/create lives in crypto/prf.ts (only this file
// imports it). PRF output is IKM; the seal KEK and AEAD seal/unseal of the
// master stay here. largeBlob UV write of seed wire lives in
// crypto/largeBlob.ts (only this file imports it). Sealed ciphertext on disk
// is useless without a ceremony Enclave itself initiates (or caller-supplied
// IKM that is wiped here).
// WebAuthn “authenticator” = binding key (IKM source, not authn/authz).
//
// Transient secrets (PRF, binding/pair KEK, derivation seed, Ed25519 priv) are
// fill(0)'d before return. JS cannot OPENSSL_cleanse, but an uncleared buffer
// is a standing copy a heap dump can steal without another UV.

import { concat } from "../binary.ts";
import { Decoder, Encoder } from "../codec.ts";
import { identityHostsCodec } from "../codecs/identityBundle.ts";
import type { BundleHost } from "../codecs/bundleHost.ts";
import { kdmBytes, Status } from "../consts.ts";
import {
  asSealedMasterKey,
  MASTER_SEED_LEN,
  type MasterSeed,
  type SealedMasterKey,
} from "../seed.ts";
import type { DerivationSeed, KeyPair, PublicKey } from "../types.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { deriveKey, nullKDM, type PDK, Purpose } from "./derivation.ts";
import {
  blake3,
  decryptXSalsa20Poly1305Combined,
  deriveEd25519KeyPair,
  encryptXSalsa20Poly1305Combined,
  gen256BitSecureRandomSeed,
  signEd25519,
} from "./noble.ts";
import {
  asDHKEResp,
  type DHKEReq,
  type DHKEResp,
  PairRequest,
  sealPair,
} from "./pairing.ts";
import {
  type LargeBlobCreateOpts,
  largeBlobRead,
  type LargeBlobRp,
} from "../webauthn/largeBlob.ts";
import {
  postToDiplomaticWorker,
  spawnDiplomaticSyncWorker,
} from "../worker/spawn.ts";
// Stay last. Seed-trace pins hash Vite's import index, so a module inserted
// earlier renumbers later imports and their pins.
import { largeBlobCredId, wipeLargeBlob, writeLargeBlob } from "./largeBlob.ts";
import {
  type BindPrior,
  type PasskeyPrfOpts,
  type PrfBinding,
  type PrfBound,
  type PrfSealedMaster,
  sealPRF,
  unsealPRF,
} from "./prf.ts";

export type EncryptCipher = {
  encrypt: (data: Uint8Array) => Promise<ValStat<Uint8Array>>;
};

export type DecryptCipher = {
  decrypt: (data: Uint8Array) => Promise<ValStat<Uint8Array>>;
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
 * KDM-scoped signing identity: public key is public; sign/kdmFor re-enter
 * the enclave so the private key never leaves. Used for hosts, export files, etc.
 */
export type Identity = {
  readonly publicKey: PublicKey;
  sign: (message: Uint8Array | string) => Promise<ValStat<Uint8Array>>;
  /** Per-bag 8-byte KDM (bag-kdm PDK child keyed by the encoded head). */
  kdmFor: (msgHeadEnc: Uint8Array) => Promise<ValStat<Uint8Array>>;
};

// bun --define DIP_CLI_DUMP=true to enable dumpToTty (hexdump.ts). Absent or
// false → NotImplemented; web/worker/pkg-cli define false so the write is DCE'd.
declare const DIP_CLI_DUMP: boolean | undefined;

const BIND_TAG_LEN = 32;
/** Minimum PRF IKM length accepted when deriving the seal KEK. */
const SEAL_PRF_MIN_LEN = 16;
/** Minimum musec length (Mandatory User-Space Entropy Contribution). */
export const MUSEC_MIN_LEN = 32;

// Host rows for IdentityBundle wire (idx defaults to 0).
function bundleHosts(hosts: BundleHost[]): BundleHost[] {
  return hosts.map((h) => ({
    handle: h.handle,
    label: h.label,
    idx: h.idx ?? 0,
  }));
}

// Absorb seed‖hosts wire. Encoder/Decoder see only the host list.
// fromLargeBlob calls this in-file. PairRequest.finish imports it.
export function fromSeedHosts(buf: Uint8Array): ValStat<{
  enclave: Enclave;
  hosts: BundleHost[];
}> {
  if (buf.byteLength === 0 || buf.every((b) => b === 0)) {
    return err(Status.MissingSeed);
  }
  // Empty hosts is a one-byte varint; shorter than 33 is not this wire.
  if (buf.byteLength < MASTER_SEED_LEN + 1) {
    return err(Status.InvalidMessage);
  }
  const seedRaw = buf.subarray(0, MASTER_SEED_LEN);
  if (seedRaw.every((b) => b === 0)) return err(Status.MissingSeed);
  const dec = new Decoder(buf.subarray(MASTER_SEED_LEN));
  const [rows, hst] = dec.readStruct(identityHostsCodec);
  if (hst !== Status.Success) return err(hst);
  if (rows === undefined) return err(Status.InvalidMessage);
  if (!dec.done()) return err(Status.InvalidMessage);
  const [enclave, est] = Enclave.fromBytes(seedRaw);
  if (est !== Status.Success) return err(est);
  return ok({
    enclave,
    hosts: rows.hosts.map((h) => ({ ...h })),
  });
}

/** Brand `bytes` as {@link MasterSeed} only if length is {@link MASTER_SEED_LEN}. */
export function asMasterSeed(bytes: Uint8Array): ValStat<MasterSeed> {
  if (bytes.byteLength !== MASTER_SEED_LEN) return err(Status.InvalidParam);
  // Inline ValStat ok: do not pass seed bytes to imported `ok`.
  return [bytes as MasterSeed, Status.Success];
}

export class Enclave {
  #seed: MasterSeed;

  private constructor(seed: MasterSeed) {
    this.#seed = seed;
  }

  /**
   * New enclave: blake3(OS CSPRNG ‖ musec). musec is required (MUSEC_MIN_LEN).
   * Mix stays in this method; musec is wiped before return.
   */
  static async fromRandom(musec: Uint8Array): Promise<ValStat<Enclave>> {
    if (musec.byteLength < MUSEC_MIN_LEN) return err(Status.InvalidParam);
    const os = await gen256BitSecureRandomSeed();
    const mix = concat(os, musec);
    try {
      const hashed = await blake3(mix);
      const [seed, st] = asMasterSeed(hashed);
      if (st !== Status.Success) return err(st);
      return ok(new Enclave(seed));
    } finally {
      os.fill(0);
      mix.fill(0);
      musec.fill(0);
    }
  }

  /**
   * Construct from raw master seed bytes (import / bootstrap only).
   * Copies the seed so callers may zero their buffer after success.
   * Prefer {@link fromRandom} or {@link unsealWithPasskey} for normal flows.
   */
  static fromBytes(bytes: Uint8Array): ValStat<Enclave> {
    const [seed, st] = asMasterSeed(bytes);
    if (st !== Status.Success) return err(st);
    const [owned, ost] = asMasterSeed(seed.slice());
    if (ost !== Status.Success) return err(ost);
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
    const [out, ost] = await sealPRF(opts);
    if (ost !== Status.Success) return err(ost);
    try {
      const [sealedMaster, sst] = await this.#sealUnderPrf(out.prf);
      if (sst !== Status.Success) return err(sst);
      return ok({
        sealedMaster,
        salt: out.salt,
        credId: out.credId,
        userId: out.userId,
        attachment: out.attachment,
        transports: out.transports,
        aaguid: out.aaguid,
      });
    } finally {
      out.prf.fill(0);
    }
  }

  /**
   * UV + PRF seal, plus a per-cred bind tag (bindtag PDK child keyed by credId).
   * Tag compute and compare stay in the enclave. If `prior` is non-empty, every
   * stored tag must match this master or bind fails (one keyring, one master).
   */
  async bind(
    opts?: PasskeyPrfOpts,
    prior?: readonly BindPrior[],
  ): Promise<ValStat<PrfBound>> {
    if (prior !== undefined) {
      for (const p of prior) {
        if (!await this.#tagMatches(p.credId, p.tag)) {
          return err(Status.InvalidParam);
        }
      }
    }
    const [sealed, sst] = await this.sealWithPasskey(opts);
    if (sst !== Status.Success) return err(sst);
    const [tag, tst] = await this.#bindTag(sealed.credId);
    if (tst !== Status.Success) return err(tst);
    return ok({ ...sealed, tag });
  }

  /**
   * UV + PRF ceremony, then unseal one of `bindings` into a new Enclave.
   * allowCredentials is the union of binding cred ids. Returns the asserted id.
   */
  static async unsealWithPasskey(
    bindings: readonly PrfBinding[],
    opts: PasskeyPrfOpts & { salt: Uint8Array },
  ): Promise<ValStat<{ enclave: Enclave; credId: Uint8Array }>> {
    if (bindings.length === 0) return err(Status.MissingSeed);
    const [out, ost] = await unsealPRF(bindings, opts);
    if (ost !== Status.Success) return err(ost);
    try {
      for (const w of out.order) {
        const [enclave] = await Enclave.#unsealUnderPrf(
          w.sealedMaster,
          out.prf,
        );
        if (enclave !== undefined) {
          return ok({ enclave, credId: out.credId });
        }
      }
      return err(Status.DecryptionError);
    } finally {
      out.prf.fill(0);
    }
  }

  /**
   * AEAD-seal master under caller-supplied PRF IKM (CLI hmac-secret).
   * Wipes `ikm` before return. Ciphertext only — never the seed.
   */
  async sealWithIkm(ikm: Uint8Array): Promise<ValStat<SealedMasterKey>> {
    try {
      return await this.#sealUnderPrf(ikm);
    } finally {
      ikm.fill(0);
    }
  }

  /**
   * Unseal a PRF binding given IKM (CLI hmac-secret eval). Returns Enclave.
   * Wipes `ikm` before return.
   */
  static async unsealWithIkm(
    sealed: SealedMasterKey,
    ikm: Uint8Array,
  ): Promise<ValStat<Enclave>> {
    try {
      return await Enclave.#unsealUnderPrf(sealed, ikm);
    } finally {
      ikm.fill(0);
    }
  }

  /**
   * UV + write IdentityBundle (seed + hosts) to largeBlob.
   * Encode stays here; {@link writeLargeBlob} does the UV write. Nothing
   * seed-bearing is returned. Prefer empty `hosts` for seed-only backup.
   *
   * Pass `opts.credId` to write an existing credential (one UV). Omit it to
   * create a largeBlob-capable credential then write (two UV). Returns the
   * credential id used.
   */
  async persistToLargeBlob(
    hosts: BundleHost[] = [],
    opts?: LargeBlobCreateOpts & { credId?: Uint8Array },
  ): Promise<ValStat<Uint8Array>> {
    const [credId, cst] = await largeBlobCredId(opts);
    if (cst !== Status.Success) return err(cst);
    const [encoded, est] = this.#encodeSeedHosts(hosts);
    if (est !== Status.Success) return err(est);
    try {
      const wst = await writeLargeBlob(credId, encoded, opts);
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
    try {
      const [out, st] = fromSeedHosts(raw.blob);
      if (st !== Status.Success) return err(st);
      return ok({ ...out, credId: raw.credId });
    } finally {
      raw.blob.fill(0);
    }
  }

  /** UV + overwrite largeBlob with zeros (destroys stored seed material). */
  static clearLargeBlob(
    credId: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<Status> {
    return wipeLargeBlob(credId, opts);
  }

  /**
   * Write numbered `n] xxxx xxxx` hex lines plus a # check to /dev/tty.
   * Paced mode erases the previous line before the next (Enter between).
   * Web bundles set DIP_CLI_DUMP=false; the write is compiled out.
   */
  async dumpToTty(): Promise<Status> {
    if (!(typeof DIP_CLI_DUMP !== "undefined" && DIP_CLI_DUMP)) {
      return Status.NotImplemented;
    }
    // Non-literal so the bundler does not pull tty.ts in before DCE.
    const ttySpec = "./tty.ts";
    const mod: unknown = await import(ttySpec);
    if (mod === null || typeof mod !== "object" || !("dumpToTty" in mod)) {
      return Status.NotImplemented;
    }
    const write = mod.dumpToTty;
    if (typeof write !== "function") return Status.NotImplemented;
    return write(this.#seed, () => this.fingerprint());
  }

  // Starts an enrollee pairing session. Carry dhkeReq to the enroller.
  static pairRequest(): Promise<ValStat<PairRequest>> {
    return PairRequest.create();
  }

  /**
   * Seals seed+hosts for dhkeReq. Returns dhkeResp to send back.
   * @param acks Set fields only after explicit user affirmation (e.g. a checkbox).
   *   Do not default these to `true` in application code.
   */
  async pairAccept(
    dhkeReq: DHKEReq,
    hosts: BundleHost[],
    acks: {
      /**
       * Set `true` only after the user explicitly affirms they control both
       * devices in this pair. Never hard-code in a client.
       */
      userControlsBothSidesOfPair: true;
    },
  ): Promise<ValStat<DHKEResp>> {
    if (acks.userControlsBothSidesOfPair !== true) {
      return err(Status.InvalidParam);
    }
    const [seal, sst] = await sealPair(dhkeReq);
    if (sst !== Status.Success) return err(sst);
    try {
      const [plain, pst] = this.#encodeSeedHosts(hosts);
      if (pst !== Status.Success) return err(pst);
      try {
        try {
          const body = await encryptXSalsa20Poly1305Combined(
            plain,
            seal.key,
          );
          return asDHKEResp(concat(seal.pub, body));
        } catch {
          return err(Status.InternalError);
        }
      } finally {
        plain.fill(0);
      }
    } finally {
      seal.key.fill(0);
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
   * Identity from the identity PDK + KDM {label: keyPath, index}. Private key
   * stays in the enclave; only publicKey and capability methods are returned.
   */
  async deriveIdentity(keyPath: string, idx = 0): Promise<ValStat<Identity>> {
    const path = keyPath;
    const index = idx;
    const [keys, st] = await this.#deriveSubkeys(path, index);
    if (st !== Status.Success) return err(st);
    const publicKey = keys.publicKey;
    // Handle only needs the pub; priv would outlive this call on the Identity.
    keys.privateKey.fill(0);
    return ok(Object.freeze({
      publicKey,
      sign: (message: Uint8Array | string) => this.#sign(path, index, message),
      kdmFor: (msgHeadEnc: Uint8Array) => this.#kdmFor(path, index, msgHeadEnc),
    }));
  }

  // Paper-check digest (null-KDM child of the fingerprint PDK).
  async fingerprint(): Promise<ValStat<PDK["Fingerprint"]>> {
    return await deriveKey({
      parent: this.#seed,
      purpose: Purpose.Fingerprint,
      kdm: nullKDM,
    });
  }

  // Bind-tag child keyed by credId. Not a global fingerprint.
  async #bindTag(credId: Uint8Array): Promise<ValStat<PDK["BindTag"]>> {
    return await deriveKey({
      parent: this.#seed,
      purpose: Purpose.BindTag,
      kdm: credId,
    });
  }

  // Constant-time match of a stored tag against this master + credId.
  async #tagMatches(credId: Uint8Array, tag: PDK["BindTag"]): Promise<boolean> {
    if (tag.byteLength !== BIND_TAG_LEN) return false;
    const [got, gst] = await this.#bindTag(credId);
    if (gst !== Status.Success) return false;
    try {
      if (got.byteLength !== tag.byteLength) return false;
      let d = 0;
      for (let i = 0; i < got.byteLength; i++) {
        const a = got[i];
        const b = tag[i];
        if (a === undefined || b === undefined) return false;
        d |= a ^ b;
      }
      return d === 0;
    } finally {
      got.fill(0);
    }
  }

  // Derive seal KEK from PRF IKM (null-KDM child of the bind PDK).
  static async #sealKeyFromPrf(prf: Uint8Array): Promise<ValStat<PDK["Bind"]>> {
    if (prf.byteLength < SEAL_PRF_MIN_LEN) return err(Status.InvalidParam);
    return deriveKey({
      parent: prf,
      purpose: Purpose.Bind,
      kdm: nullKDM,
    });
  }

  /** AEAD-seal master under KDF(PRF). Caller wipes the PRF bytes. */
  async #sealUnderPrf(prf: Uint8Array): Promise<ValStat<SealedMasterKey>> {
    const [key, kst] = await Enclave.#sealKeyFromPrf(prf);
    if (kst !== Status.Success) return err(kst);
    try {
      const sealed = await encryptXSalsa20Poly1305Combined(
        this.#seed,
        key,
      );
      return asSealedMasterKey(sealed);
    } catch {
      return err(Status.InternalError);
    } finally {
      // Binding KEK decrypts durable master; do not leave it after seal.
      key.fill(0);
    }
  }

  static async #unsealUnderPrf(
    sealed: SealedMasterKey,
    prf: Uint8Array,
  ): Promise<ValStat<Enclave>> {
    const [, sst] = asSealedMasterKey(sealed);
    if (sst !== Status.Success) return err(sst);
    const [key, kst] = await Enclave.#sealKeyFromPrf(prf);
    if (kst !== Status.Success) return err(kst);
    let plain: Uint8Array | undefined;
    try {
      try {
        plain = await decryptXSalsa20Poly1305Combined(sealed, key);
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
   * Private: seed‖hosts wire (largeBlob persist and pair AEAD inner).
   * Never expose this buffer outside Enclave methods.
   */
  #encodeSeedHosts(hosts: BundleHost[]): ValStat<Uint8Array> {
    const enc = new Encoder();
    const st = enc.writeStruct(identityHostsCodec, {
      hosts: bundleHosts(hosts),
    });
    if (st !== Status.Success) return err(st);
    const hostsEnc = enc.result();
    const out = new Uint8Array(MASTER_SEED_LEN + hostsEnc.byteLength);
    out.set(this.#seed, 0);
    out.set(hostsEnc, MASTER_SEED_LEN);
    // Inline ValStat ok: do not pass seed-bearing `out` to imported `ok`.
    return [out, Status.Success];
  }

  async #encrypt(
    kdm: Uint8Array,
    data: Uint8Array,
  ): Promise<ValStat<Uint8Array>> {
    const [key, st] = await this.#keyFromKDM(kdm);
    if (st !== Status.Success) return err(st);
    try {
      try {
        return ok(await encryptXSalsa20Poly1305Combined(data, key));
      } catch {
        return err(Status.CryptoError);
      }
    } finally {
      key.fill(0);
    }
  }

  async #decrypt(
    kdm: Uint8Array,
    data: Uint8Array,
  ): Promise<ValStat<Uint8Array>> {
    const [key, st] = await this.#keyFromKDM(kdm);
    if (st !== Status.Success) return err(st);
    try {
      try {
        return ok(await decryptXSalsa20Poly1305Combined(data, key));
      } catch {
        return err(Status.DecryptionError);
      }
    } finally {
      key.fill(0);
    }
  }

  async #keyFromKDM(kdm: Uint8Array): Promise<ValStat<PDK["Cipher"]>> {
    return await deriveKey({
      parent: this.#seed,
      purpose: Purpose.Cipher,
      kdm,
    });
  }

  async #deriveSeed(
    keyPath: string,
    idx: number,
  ): Promise<ValStat<PDK["Identity"]>> {
    return await deriveKey({
      parent: this.#seed,
      purpose: Purpose.Identity,
      kdm: { label: keyPath, index: idx },
    });
  }

  async #deriveSubkeys(
    keyPath: string,
    idx: number,
  ): Promise<ValStat<KeyPair>> {
    const [seed, st] = await this.#deriveSeed(keyPath, idx);
    if (st !== Status.Success) return err(st);
    try {
      try {
        return ok(await deriveEd25519KeyPair(asDerivSeed(seed)));
      } catch {
        return err(Status.CryptoError);
      }
    } finally {
      // Pair already holds seed‖pub; this 32-byte deriv must not linger.
      seed.fill(0);
    }
  }

  async #sign(
    keyPath: string,
    idx: number,
    message: Uint8Array | string,
  ): Promise<ValStat<Uint8Array>> {
    const [keys, st] = await this.#deriveSubkeys(keyPath, idx);
    if (st !== Status.Success) return err(st);
    try {
      try {
        return ok(await signEd25519(message, keys.privateKey));
      } catch {
        return err(Status.CryptoError);
      }
    } finally {
      // Re-derived per sign so the caller never holds a long-lived priv.
      keys.privateKey.fill(0);
    }
  }

  async #kdmFor(
    keyPath: string,
    idx: number,
    msgHeadEnc: Uint8Array,
  ): Promise<ValStat<Uint8Array>> {
    const [idSeed, st] = await this.#deriveSeed(keyPath, idx);
    if (st !== Status.Success) return err(st);
    try {
      const [child, cst] = await deriveKey({
        parent: idSeed,
        purpose: Purpose.BagKdm,
        kdm: msgHeadEnc,
      });
      if (cst !== Status.Success) return err(cst);
      try {
        return ok(child.slice(0, kdmBytes));
      } finally {
        child.fill(0);
      }
    } finally {
      idSeed.fill(0);
    }
  }
}

// Brands an identity child as the Ed25519 derivation seed for that identity.
function asDerivSeed(
  child: PDK["Identity"],
): DerivationSeed {
  return child as Uint8Array as DerivationSeed;
}

const LOCK_SKIP = new Set(["constructor", "prototype", "length", "name"]);

// Freeze every public fn slot on obj so it cannot be replaced after load.
function lockAll(obj: object): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (LOCK_SKIP.has(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined || typeof desc.value !== "function") continue;
    Object.defineProperty(obj, key, {
      value: desc.value,
      writable: false,
      configurable: false,
    });
  }
}

lockAll(Enclave);
lockAll(Enclave.prototype);
