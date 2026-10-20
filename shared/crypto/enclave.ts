// Enclave is the outer layer. InnerEnclave holds the master seed and is not
// exported. Public methods are locked after the class (non-writable,
// non-configurable) so they cannot be replaced after load.
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
//      Do not export a seed helper. Inner returns derived bytes or a status.
//
// Callers may receive only: BagManager (one identity and one realm), AEAD
// ciphertext, Status/booleans, and new Enclave instances from factories.
// bagman copies an Identity PDK (from the master seed), a realm key, and an rlm out. bagman.ts
// never receives the seed.
//
// dumpToTTY (paper): 8×8 hex to /dev/tty, Status only. Fail closed: the write
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

import type { BundleHost } from "../codecs/bundleHost.ts";
import type { IKDM } from "../codecs/kdm.ts";
import type { MasterSeed, SealedMasterKey } from "../seed.ts";
import type { ValStat } from "../valstat.ts";
import type { PDK } from "./derivation.ts";
import type { DHKEReq, DHKEResp } from "./pairing.ts";
import type {
  LargeBlobCreateOpts,
  LargeBlobRp,
} from "../webauthn/largeBlob.ts";
import type {
  BindPrior,
  PasskeyPrfOpts,
  PrfBinding,
  PrfBound,
  PrfSealedMaster,
} from "./prf.ts";
import { concat } from "../binary.ts";
import { Decoder, Encoder } from "../codec.ts";
import { identityHostsCodec } from "../codecs/identityBundle.ts";
import { Status } from "../consts.ts";
import { asSealedMasterKey, MASTER_SEED_LEN } from "../seed.ts";
import { err, ok } from "../valstat.ts";
import { deriveKey, nullKDM, Purpose } from "./derivation.ts";
import {
  blake3,
  decryptXSalsa20Poly1305Combined,
  encryptXSalsa20Poly1305Combined,
  gen256BitSecureRandomSeed,
} from "./noble.ts";
import { asDHKEResp, PairRequest, sealPair } from "./pairing.ts";
import { largeBlobRead } from "../webauthn/largeBlob.ts";
import {
  postToDiplomaticWorker,
  spawnDiplomaticSyncWorker,
} from "../worker/spawn.ts";
// Stay last. Seed-trace pins hash Vite's import index, so a module inserted
// earlier renumbers later imports and their pins. Type imports are not indexed.
import { largeBlobCredId, wipeLargeBlob, writeLargeBlob } from "./largeBlob.ts";
import { sealPRF, unsealPRF } from "./prf.ts";
import { deriveHostRLM, deriveRealmID, deriveRealmKey } from "./realms.ts";
import { BagManager } from "./bagman.ts";
import { bytesEqual } from "./binary.ts";

// bun --define DIP_CLI_DUMP=true to enable dumpToTTY (hexdump.ts). Absent or
// false → NotImplemented; web/worker/pkg-cli define false so the write is DCE'd.
declare const DIP_CLI_DUMP: boolean | undefined;

const BIND_TAG_LEN = 32;
/** Minimum PRF IKM length accepted when deriving the seal KEK. */
const SEAL_PRF_MIN_LEN = 16;
/** Minimum musec length (Mandatory User-Space Entropy Contribution). */
export const MUSEC_MIN_LEN = 32;

// Absorb seed‖hosts wire. Encoder/Decoder see only the host list.
// fromLargeBlob calls this in-file. PairRequest.finish imports it.
export function fromSeedHosts(buf: Uint8Array): ValStat<{
  enclave: OuterEnclave;
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
  const [enclave, est] = OuterEnclave.fromBytes(seedRaw);
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

// Seal KEK: null-KDM child of the bind PDK. The parent is the PRF IKM.
async function sealKeyFromPRF(prf: Uint8Array): Promise<ValStat<PDK["Bind"]>> {
  if (prf.byteLength < SEAL_PRF_MIN_LEN) return err(Status.InvalidParam);
  const purpose = Purpose.Bind;
  return deriveKey({ parent: prf, purpose, kdm: nullKDM });
}

// Byte machine. Holds the master. Returns derived bytes or a status.
class InnerEnclave {
  #seed: MasterSeed;

  private constructor(seed: MasterSeed) {
    this.#seed = seed;
  }

  // blake3(OS CSPRNG ‖ musec). Keeps the digest and wipes both inputs.
  // Rejects a short musec. A rejected digest is wiped.
  static async mix(musec: Uint8Array): Promise<ValStat<InnerEnclave>> {
    let os: Uint8Array | undefined;
    let buf: Uint8Array | undefined;
    let hashed: Uint8Array | undefined;
    try {
      if (musec.byteLength < MUSEC_MIN_LEN) return err(Status.InvalidParam);
      os = await gen256BitSecureRandomSeed();
      buf = new Uint8Array(os.byteLength + musec.byteLength);
      buf.set(os, 0);
      buf.set(musec, os.byteLength);
      hashed = await blake3(buf);
      const [seed, st] = asMasterSeed(hashed);
      if (st !== Status.Success) return err(st);
      const inner = new InnerEnclave(seed);
      // Digest buffer is #seed. Drop the local so finally does not wipe it.
      hashed = undefined;
      return ok(inner);
    } finally {
      os?.fill(0);
      buf?.fill(0);
      musec.fill(0);
      hashed?.fill(0);
    }
  }

  // Opens a session from raw seed bytes. Copies so the caller can wipe theirs.
  static importSeed(bytes: Uint8Array): ValStat<InnerEnclave> {
    const [seed, st] = asMasterSeed(bytes);
    if (st !== Status.Success) return err(st);
    const [owned, ost] = asMasterSeed(seed.slice());
    if (ost !== Status.Success) return err(ost);
    return ok(new InnerEnclave(owned));
  }

  // Opens a session by decrypting a sealed master. Caller wipes `ikm`.
  static async unseal(
    sealed: SealedMasterKey,
    ikm: Uint8Array,
  ): Promise<ValStat<InnerEnclave>> {
    const [, sst] = asSealedMasterKey(sealed);
    if (sst !== Status.Success) return err(sst);
    const [key, kst] = await sealKeyFromPRF(ikm);
    if (kst !== Status.Success) return err(kst);
    let plain: Uint8Array | undefined;
    try {
      try {
        plain = await decryptXSalsa20Poly1305Combined(sealed, key);
      } catch {
        return err(Status.DecryptionError);
      }
      // importSeed copies; wipe the decrypt buffer.
      return InnerEnclave.importSeed(plain);
    } finally {
      key.fill(0);
      plain?.fill(0);
    }
  }

  // Identity PDK for this label, from the master.
  async idnt(kdm: IKDM): Promise<ValStat<PDK["Identity"]>> {
    const purpose = Purpose.Identity;
    return deriveKey({ parent: this.#seed, purpose, kdm });
  }

  // Realm key for this realm KDM.
  async realmKey(kdm: IKDM): Promise<ValStat<PDK["RealmKey"]>> {
    return deriveRealmKey(this.#seed, kdm);
  }

  // Stable realm id (account key + realm KDM). No host material.
  async realmID(realmKDM: IKDM): Promise<ValStat<PDK["RealmID"]>> {
    return deriveRealmID(this.#seed, realmKDM);
  }

  // Fingerprint-PDK child. No kdm is the paper check (null KDM).
  async fingerprint(
    kdm: Uint8Array | IKDM,
  ): Promise<ValStat<PDK["Fingerprint"]>> {
    const purpose = Purpose.Fingerprint;
    return await deriveKey({ parent: this.#seed, purpose, kdm });
  }

  // Bind-tag child keyed by credId. Not a global fingerprint.
  async bindTag(credId: Uint8Array): Promise<ValStat<PDK["BindTag"]>> {
    const purpose = Purpose.BindTag;
    return await deriveKey({ parent: this.#seed, purpose, kdm: credId });
  }

  // AEAD-seal the master under KDF(IKM). Caller wipes `ikm`.
  async seal(ikm: Uint8Array): Promise<ValStat<SealedMasterKey>> {
    const [key, kst] = await sealKeyFromPRF(ikm);
    if (kst !== Status.Success) return err(kst);
    try {
      const sealed = await encryptXSalsa20Poly1305Combined(this.#seed, key);
      return asSealedMasterKey(sealed);
    } catch {
      return err(Status.InternalError);
    } finally {
      key.fill(0);
    }
  }

  // Encrypts seed‖hosts under `wrapKey`. Wipes the plaintext wire.
  async sealSeedHosts(
    wrapKey: Uint8Array,
    hosts: BundleHost[],
  ): Promise<ValStat<Uint8Array>> {
    const [plain, pst] = this.#exportSeedHosts(hosts);
    if (pst !== Status.Success) return err(pst);
    try {
      return ok(await encryptXSalsa20Poly1305Combined(plain, wrapKey));
    } catch {
      return err(Status.InternalError);
    } finally {
      plain.fill(0);
    }
  }

  // seed‖hosts wire. Callers wipe the buffer. Do not pass it to imported ok.
  #exportSeedHosts(hosts: BundleHost[]): ValStat<Uint8Array> {
    const enc = new Encoder();
    const st = enc.writeStruct(identityHostsCodec, {
      hosts: hosts.map((h) => ({
        handle: h.handle,
        label: h.label,
        idx: h.idx ?? 0,
      })),
    });
    if (st !== Status.Success) return err(st);
    const hostsEnc = enc.result();
    const out = new Uint8Array(MASTER_SEED_LEN + hostsEnc.byteLength);
    out.set(this.#seed, 0);
    out.set(hostsEnc, MASTER_SEED_LEN);
    return [out, Status.Success];
  }

  // UV-writes seed‖hosts. Wipes the wire. Returns the credential id used.
  async persistToLargeBlob(
    hosts: BundleHost[],
    opts?: LargeBlobCreateOpts & { credId?: Uint8Array },
  ): Promise<ValStat<Uint8Array>> {
    const [credId, cst] = await largeBlobCredId(opts);
    if (cst !== Status.Success) return err(cst);
    const [encoded, est] = this.#exportSeedHosts(hosts);
    if (est !== Status.Success) return err(est);
    try {
      const wst = await writeLargeBlob(credId, encoded, opts);
      if (wst !== Status.Success) return err(wst);
      return ok(credId);
    } finally {
      encoded.fill(0);
    }
  }

  // Paper hex of the master. NotImplemented unless DIP_CLI_DUMP is true.
  async dumpToTTY(): Promise<Status> {
    if (!(typeof DIP_CLI_DUMP !== "undefined" && DIP_CLI_DUMP)) {
      return Status.NotImplemented;
    }
    // Non-literal so the bundler does not pull tty.ts in before DCE.
    const ttySpec = "./tty.ts";
    const mod: unknown = await import(ttySpec);
    if (mod === null || typeof mod !== "object" || !("dumpToTTY" in mod)) {
      return Status.NotImplemented;
    }
    const write = mod.dumpToTTY;
    if (typeof write !== "function") return Status.NotImplemented;
    const seed = this.#seed.slice();
    try {
      return await write(seed, () => this.fingerprint(nullKDM));
    } finally {
      seed.fill(0);
    }
  }

  // Copies the master for a worker this process just spawned.
  // A hardware boundary drops this with spawnSyncWorker.
  // TODO: eliminate this by giving the worker a minimal keyset (TWKs).
  copyForWorker(): Uint8Array {
    return this.#seed.slice();
  }
}

// Outer layer. Ceremonies and BagManagers. The master stays in InnerEnclave.
class OuterEnclave {
  #inner: InnerEnclave;

  private constructor(inner: InnerEnclave) {
    this.#inner = inner;
  }

  /**
   * New enclave: blake3(OS CSPRNG ‖ musec). musec is required (MUSEC_MIN_LEN).
   * Musec is wiped on every return, including rejection and a throw from the
   * OS generator. A rejected digest is wiped. The stored seed is that digest
   * buffer, so the success path must not wipe it.
   */
  static async fromRandom(musec: Uint8Array): Promise<ValStat<OuterEnclave>> {
    try {
      const [inner, st] = await InnerEnclave.mix(musec);
      if (st !== Status.Success) return err(st);
      return ok(new OuterEnclave(inner));
    } finally {
      musec.fill(0);
    }
  }

  /**
   * Construct from raw master seed bytes (import / bootstrap only).
   * Copies the seed so callers may zero their buffer after success.
   * Prefer {@link fromRandom} or {@link unsealWithPasskey} for normal flows.
   */
  static fromBytes(bytes: Uint8Array): ValStat<OuterEnclave> {
    const [inner, st] = InnerEnclave.importSeed(bytes);
    if (st !== Status.Success) return err(st);
    return ok(new OuterEnclave(inner));
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
      const [sealedMaster, sst] = await this.#inner.seal(out.prf);
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
        if (p.tag.byteLength !== BIND_TAG_LEN) return err(Status.InvalidParam);
        const [got, gst] = await this.#inner.bindTag(p.credId);
        if (gst !== Status.Success) return err(gst);
        try {
          if (!bytesEqual(got, p.tag)) return err(Status.InvalidParam);
        } finally {
          got.fill(0);
        }
      }
    }
    const [sealed, sst] = await this.sealWithPasskey(opts);
    if (sst !== Status.Success) return err(sst);
    const [tag, tst] = await this.#inner.bindTag(sealed.credId);
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
  ): Promise<ValStat<{ enclave: OuterEnclave; credId: Uint8Array }>> {
    if (bindings.length === 0) return err(Status.MissingSeed);
    const [out, ost] = await unsealPRF(bindings, opts);
    if (ost !== Status.Success) return err(ost);
    try {
      for (const w of out.order) {
        const [inner, ist] = await InnerEnclave.unseal(
          w.sealedMaster,
          out.prf,
        );
        if (ist === Status.Success) {
          return ok({ enclave: new OuterEnclave(inner), credId: out.credId });
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
  async sealWithIKM(ikm: Uint8Array): Promise<ValStat<SealedMasterKey>> {
    try {
      return await this.#inner.seal(ikm);
    } finally {
      ikm.fill(0);
    }
  }

  /**
   * Unseal a PRF binding given IKM (CLI hmac-secret eval). Returns Enclave.
   * Wipes `ikm` before return.
   */
  static async unsealWithIKM(
    sealed: SealedMasterKey,
    ikm: Uint8Array,
  ): Promise<ValStat<OuterEnclave>> {
    try {
      const [inner, st] = await InnerEnclave.unseal(sealed, ikm);
      if (st !== Status.Success) return err(st);
      return ok(new OuterEnclave(inner));
    } finally {
      ikm.fill(0);
    }
  }

  /**
   * UV + write IdentityBundle (seed + hosts) to largeBlob.
   * Inner encodes the wire and {@link writeLargeBlob} does the UV write.
   * Nothing seed-bearing is returned. Prefer empty `hosts` for seed-only backup.
   *
   * Pass `opts.credId` to write an existing credential (one UV). Omit it to
   * create a largeBlob-capable credential then write (two UV). Returns the
   * credential id used.
   */
  async persistToLargeBlob(
    hosts: BundleHost[] = [],
    opts?: LargeBlobCreateOpts & { credId?: Uint8Array },
  ): Promise<ValStat<Uint8Array>> {
    return this.#inner.persistToLargeBlob(hosts, opts);
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
    ValStat<{ enclave: OuterEnclave; hosts: BundleHost[]; credId: Uint8Array }>
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
  async dumpToTTY(): Promise<Status> {
    return this.#inner.dumpToTTY();
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
      const [body, bst] = await this.#inner.sealSeedHosts(seal.key, hosts);
      if (bst !== Status.Success) return err(bst);
      return asDHKEResp(concat(seal.pub, body));
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
    const seed = this.#inner.copyForWorker();
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

  // Returns the BagManager for one identity KDM x realm combination.
  async bagman(idKDM: IKDM, realmKDM: IKDM): Promise<ValStat<BagManager>> {
    const [idnt, ist] = await this.#inner.idnt(idKDM);
    if (ist !== Status.Success) return err(ist);
    const [realm, rst] = await this.#inner.realmKey(realmKDM);
    if (rst !== Status.Success) {
      idnt.fill(0);
      return err(rst);
    }
    const [rid, idst] = await this.#inner.realmID(realmKDM);
    if (idst !== Status.Success) {
      idnt.fill(0);
      realm.fill(0);
      return err(idst);
    }
    try {
      const [rlm, lst] = await deriveHostRLM(rid, idKDM);
      if (lst !== Status.Success) {
        idnt.fill(0);
        realm.fill(0);
        return err(lst);
      }
      return BagManager.init(idnt, realm, rlm, idKDM, realmKDM);
    } finally {
      rid.fill(0);
    }
  }

  // Fingerprint-PDK child. No kdm is the paper check (null KDM).
  // A raw nonce is the per-account master check.
  async fingerprint(
    kdm: Uint8Array | IKDM = nullKDM,
  ): Promise<ValStat<PDK["Fingerprint"]>> {
    return this.#inner.fingerprint(kdm);
  }
}

// Callers keep this name. It is OuterEnclave.
export { OuterEnclave as Enclave };

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

lockAll(OuterEnclave);
lockAll(OuterEnclave.prototype);
