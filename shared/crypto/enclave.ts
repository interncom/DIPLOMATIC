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
//      that handoff is pinned in web/test/enclave.test.ts. Do not export a
//      seed helper for outer layers.
//
// Callers may receive only: derived public handles (Identity, ciphers), AEAD
// ciphertext, Status/booleans, and new Enclave instances from factories.
//
// dumpToTty (paper): 8×8 hex to /dev/tty, Status only. Fail closed: the write
// runs only when DIP_CLI_DUMP is defined and true. Keep
// `typeof DIP_CLI_DUMP !== "undefined" && DIP_CLI_DUMP` inlined in the method
// — a helper blocks DCE and would ship the write in the web bundle.
// Web/worker/pkg-cli: bun --define DIP_CLI_DUMP=false (DCE). tools/keys/hexdump
// re-execs with DIP_CLI_DUMP=true. Missing define → NotImplemented.
//
// Browser WebAuthn: largeBlob create/read and PRF capability probe live in
// shared/webauthn. PRF eval/create and CLI IKM seal/unseal live here — PRF
// output is IKM that unseals a binding and must not leave this file.
// largeBlob UV write of seed wire lives in crypto/largeBlob.ts (only this
// file imports it). Sealed ciphertext on disk is useless without a ceremony
// Enclave itself initiates (or caller-supplied IKM that is wiped here).
// WebAuthn “authenticator” = binding key (IKM source, not authn/authz).
//
// Transient secrets (PRF, binding/pair KEK, derivation seed, Ed25519 priv) are
// fill(0)'d before return. JS cannot OPENSSL_cleanse, but an uncleared buffer
// is a standing copy a heap dump can steal without another UV.

import { bytesEqual, concat } from "../binary.ts";
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
import {
  asChildKey,
  type ChildKey,
  deriveKey,
  nullKDM,
  Purpose,
} from "./derivation.ts";
import {
  blake3,
  decryptXSalsa20Poly1305Combined,
  deriveEd25519KeyPair,
  encryptXSalsa20Poly1305Combined,
  gen256BitSecureRandomSeed,
  genX25519,
  signEd25519,
} from "./noble.ts";
import {
  asDHKEReq,
  asDHKEResp,
  type DHKEReq,
  type DHKEResp,
  pairKey,
  X25519_PUB_LEN,
} from "./pairing.ts";
import type { X25519Sk } from "./x25519.ts";
import { randomBytesArrayBuffer } from "./entropy.ts";
import {
  asPublicKeyCredential,
  bufferSourceToUint8,
  checkWebAuthn,
  copyToArrayBuffer,
  DEFAULT_WEBAUTHN_RP_NAME,
  noteWebAuthnError,
  readAaguid,
  readAttachment,
  readTransports,
  resolveWebAuthnRpId,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_CRED_TYPE,
  WEBAUTHN_PUB_KEY_PARAMS,
  webAuthnCreate,
  webAuthnGet,
  type WebAuthnHint,
} from "../webauthn/common.ts";
import {
  type LargeBlobCreateOpts,
  largeBlobRead,
  type LargeBlobRp,
} from "../webauthn/largeBlob.ts";
import {
  DEFAULT_PRF_SALT,
  DEFAULT_PRF_USER_NAME,
  type PrfCeremony,
  type PrfCreateOpts,
  type PrfEvalOpts,
  type PrfRp,
} from "../webauthn/prf.ts";
import {
  postToDiplomaticWorker,
  spawnDiplomaticSyncWorker,
} from "../worker/spawn.ts";
// Stay last. Seed-trace pins hash Vite's import index, so a module inserted
// earlier renumbers later imports and their pins.
import { largeBlobCredId, wipeLargeBlob, writeLargeBlob } from "./largeBlob.ts";

export type { LargeBlobCreateOpts, LargeBlobRp };
export type { PrfCreateOpts, PrfEvalOpts, PrfRp };

/** Options for PRF seal/unseal ceremonies (no raw PRF bytes). */
export type PasskeyPrfOpts = PrfCreateOpts & {
  credId?: Uint8Array | readonly Uint8Array[];
  /** Seal only: create a PRF credential first when no credId is known. */
  createCredIfNeeded?: boolean;
};

/** One binding to try on unseal (cred id + sealed master). */
export type PrfBinding = {
  sealedMaster: SealedMasterKey;
  credId: Uint8Array;
};

/** Durable PRF-sealed master + public ceremony facts (never includes PRF output). */
export type PrfSealedMaster = PrfCeremony & {
  sealedMaster: SealedMasterKey;
  salt: Uint8Array;
};

/** One existing keyring member used to prove this enclave matches the list. */
export type BindPrior = {
  credId: Uint8Array;
  tag: ChildKey<typeof Purpose.BindTag>;
};

/** Seal + bind-tag from {@link Enclave.bind} (tag is not a global fingerprint). */
export type PrfBound = PrfSealedMaster & {
  tag: ChildKey<typeof Purpose.BindTag>;
};

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
const SEAL_PRF_MIN_LEN = 16;
/** Minimum musec length (Mandatory User-Space Entropy Contribution). */
const MUSEC_MIN_LEN = 32;

// Host rows for IdentityBundle wire (idx defaults to 0).
function bundleHosts(hosts: BundleHost[]): BundleHost[] {
  return hosts.map((h) => ({
    handle: h.handle,
    label: h.label,
    idx: h.idx ?? 0,
  }));
}

// Absorb seed‖hosts wire. Encoder/Decoder see only the host list.
function fromSeedHosts(
  buf: Uint8Array,
): ValStat<{ enclave: Enclave; hosts: BundleHost[] }> {
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

// Enrollee pairing session. Not exported; obtain via Enclave.pairRequest.
class PairRequest {
  #priv: X25519Sk;
  #dhkeReq: DHKEReq;

  private constructor(priv: X25519Sk, dhkeReq: DHKEReq) {
    this.#priv = priv;
    this.#dhkeReq = dhkeReq;
  }

  // Starts an enrollee pairing session. Carry dhkeReq to the enroller.
  static async create(): Promise<ValStat<PairRequest>> {
    let priv: X25519Sk | undefined;
    try {
      const pair = await genX25519();
      priv = pair.priv;
      const [dhkeReq, qst] = asDHKEReq(pair.pub);
      if (qst !== Status.Success) return err(qst);
      const req = new PairRequest(priv, dhkeReq);
      priv = undefined;
      return ok(req);
    } catch {
      return err(Status.CryptoError);
    } finally {
      priv?.fill(0);
    }
  }

  // Drops the ephemeral scalar. Call if the user abandons pairing.
  wipe(): void {
    this.#priv.fill(0);
  }

  // Copy of the enrollee X25519 public key to send to the enroller.
  // Branding the copy checks the length. On failure the private field stays put.
  dhkeReq(): ValStat<DHKEReq> {
    const copy = this.#dhkeReq.slice();
    const [branded, st] = asDHKEReq(copy);
    if (st !== Status.Success) return err(st);
    return ok(branded);
  }

  // Decrypts the enroller's DHKE response into a new Enclave + hosts.
  // Then call sealWithPasskey for a durable binding.
  async finish(
    dhkeResp: DHKEResp,
  ): Promise<ValStat<{ enclave: Enclave; hosts: BundleHost[] }>> {
    const respPub = dhkeResp.subarray(0, X25519_PUB_LEN);
    const body = dhkeResp.subarray(X25519_PUB_LEN);
    const [key, kst] = await pairKey(
      this.#priv,
      respPub,
      this.#dhkeReq,
      respPub,
    );
    if (kst !== Status.Success) return err(kst);
    let plain: Uint8Array | undefined;
    try {
      try {
        plain = await decryptXSalsa20Poly1305Combined(body, key);
      } catch {
        return err(Status.DecryptionError);
      }
      const out = fromSeedHosts(plain);
      if (out[1] === Status.Success) this.wipe();
      return out;
    } finally {
      key.fill(0);
      plain?.fill(0);
    }
  }
}
export type { PairRequest };

const PRF_OUTPUT_LEN = 32;

type PrfCreateResult = PrfCeremony & {
  prfEnabled: boolean;
  prf?: Uint8Array;
};

type PrfEvalResult = PrfCeremony & {
  prf: Uint8Array;
};

type PrfGetOpts = PublicKeyCredentialRequestOptions & {
  hints?: WebAuthnHint[];
};

function credIdList(
  id: Uint8Array | readonly Uint8Array[] | undefined,
): Uint8Array[] {
  if (id === undefined) return [];
  if (id instanceof Uint8Array) return [id];
  return id.filter((c) => c.byteLength > 0);
}

// True when the UA rejected prf.eval at create (before a ceremony).
function prfEvalUnsupported(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "NotSupportedError" || e.name === "TypeError";
}

// Copies PRF results.first to 32 owned bytes, or undefined.
// Zeros any leftover owned copy (short output or unused tail).
function readPrfFirst(first: BufferSource | undefined): Uint8Array | undefined {
  if (first === undefined) return undefined;
  const raw = bufferSourceToUint8(first);
  if (raw.byteLength < PRF_OUTPUT_LEN) {
    raw.fill(0);
    return undefined;
  }
  if (raw.byteLength === PRF_OUTPUT_LEN) return raw;
  const prf = raw.slice(0, PRF_OUTPUT_LEN);
  raw.fill(0);
  return prf;
}

// Create a discoverable credential that enables PRF. File-local (PRF is IKM).
async function createPrfCred(
  opts?: PrfCreateOpts,
): Promise<ValStat<PrfCreateResult>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return err(rst);
  if (rpId === undefined) return err(Status.MissingParam);

  const name = opts?.userName ?? DEFAULT_PRF_USER_NAME;
  const displayName = opts?.displayName ?? name;
  const userId = randomBytesArrayBuffer(16);
  // Roaming USB on Android: discoverable + UV-required is refused (NotAllowed /
  // NotReadable) before a picker. hmac-secret works on non-resident creds;
  // we store credId for the later get().
  const roaming = opts?.authenticatorAttachment === "cross-platform";
  const selection: AuthenticatorSelectionCriteria = {
    residentKey: roaming ? "discouraged" : "required",
    requireResidentKey: !roaming,
    userVerification: roaming ? "preferred" : "required",
  };
  if (opts?.authenticatorAttachment !== undefined) {
    selection.authenticatorAttachment = opts.authenticatorAttachment;
  }

  const pubBase = {
    challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
    rp: { id: rpId, name: opts?.rpName ?? DEFAULT_WEBAUTHN_RP_NAME },
    user: {
      id: userId,
      name,
      displayName,
    },
    pubKeyCredParams: WEBAUTHN_PUB_KEY_PARAMS,
    authenticatorSelection: selection,
    ...(opts?.hints !== undefined ? { hints: opts.hints } : {}),
    ...(opts?.excludeCredentials !== undefined &&
        opts.excludeCredentials.length > 0
      ? {
        excludeCredentials: opts.excludeCredentials.map((id) => ({
          type: WEBAUTHN_CRED_TYPE,
          id: copyToArrayBuffer(id),
        })),
      }
      : {}),
  };

  const saltBuf = opts?.salt !== undefined
    ? copyToArrayBuffer(opts.salt)
    : undefined;

  const createOnce = (evalOnCreate: boolean) =>
    webAuthnCreate({
      publicKey: {
        ...pubBase,
        extensions: evalOnCreate && saltBuf !== undefined
          ? { prf: { eval: { first: saltBuf } } }
          : { prf: {} },
      },
    });

  let cred: Credential | null;
  try {
    cred = await createOnce(saltBuf !== undefined);
  } catch (e) {
    // Retry enable-only only if the UA rejected prf.eval before a ceremony.
    if (saltBuf === undefined || !prfEvalUnsupported(e)) {
      noteWebAuthnError(e);
      return err(Status.WebAuthnError);
    }
    try {
      cred = await createOnce(false);
    } catch (e2) {
      noteWebAuthnError(e2);
      return err(Status.WebAuthnError);
    }
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const ext = pk.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: BufferSource } };
  };
  const prf = readPrfFirst(ext.prf?.results?.first);
  const prfEnabled = ext.prf?.enabled === true || prf !== undefined;
  // Roaming create is UV-preferred; hmac-secret UV/non-UV differ. Eval on get.
  if (roaming && prf !== undefined) prf.fill(0);
  return ok({
    credId: new Uint8Array(pk.rawId),
    userId: new Uint8Array(userId),
    prfEnabled,
    prf: roaming ? undefined : prf,
    attachment: readAttachment(pk.authenticatorAttachment),
    transports: readTransports(pk),
    aaguid: readAaguid(pk),
  });
}

// Evaluate PRF (UV). File-local (PRF is IKM).
async function evalPrf(
  opts?: PrfEvalOpts,
): Promise<ValStat<PrfEvalResult>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return err(rst);
  if (rpId === undefined) return err(Status.MissingParam);

  const salt = opts?.salt ?? DEFAULT_PRF_SALT;
  const saltBuf = copyToArrayBuffer(salt);
  const publicKey: PrfGetOpts = {
    challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
    rpId,
    userVerification: "preferred",
    extensions: {
      prf: {
        eval: { first: saltBuf },
      },
    },
  };
  if (opts?.hints !== undefined) publicKey.hints = opts.hints;
  const allow = credIdList(opts?.credId);
  if (allow.length > 0) {
    publicKey.allowCredentials = allow.map((id) => ({
      type: WEBAUTHN_CRED_TYPE,
      id: copyToArrayBuffer(id),
    }));
  }

  let cred: Credential | null;
  try {
    cred = await webAuthnGet({ publicKey });
  } catch (e) {
    noteWebAuthnError(e);
    return err(Status.WebAuthnError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const results = (
    pk.getClientExtensionResults() as {
      prf?: { results?: { first?: BufferSource } };
    }
  ).prf?.results;
  if (results?.first === undefined) return err(Status.MissingBody);
  const prf = readPrfFirst(results.first);
  if (prf === undefined) return err(Status.InvalidResponse);
  return ok({
    prf,
    credId: new Uint8Array(pk.rawId),
    attachment: readAttachment(pk.authenticatorAttachment),
    transports: readTransports(pk),
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
    const salt = opts?.salt ?? DEFAULT_PRF_SALT;
    const known = opts?.credId;
    let credId: Uint8Array | readonly Uint8Array[] | undefined = known;
    const needCreate = opts?.createCredIfNeeded === true &&
      (known === undefined ||
        !(known instanceof Uint8Array) && known.length === 0);

    let created: PrfCeremony | undefined;
    let createPrf: Uint8Array | undefined;
    if (needCreate) {
      const [c, cst] = await createPrfCred({
        rpId: opts?.rpId,
        rpName: opts?.rpName,
        userName: opts?.userName ?? DEFAULT_PRF_USER_NAME,
        displayName: opts?.displayName,
        authenticatorAttachment: opts?.authenticatorAttachment,
        hints: opts?.hints,
        excludeCredentials: opts?.excludeCredentials,
        salt,
      });
      if (cst !== Status.Success) return err(cst);
      if (c === undefined) return err(Status.WebAuthnError);
      if (!c.prfEnabled) return err(Status.WebAuthnError);
      credId = c.credId;
      created = c;
      createPrf = c.prf;
    }

    const finish = async (
      prf: Uint8Array,
      evCredId: Uint8Array,
      evAttachment?: PrfCeremony["attachment"],
      evTransports?: string[],
    ): Promise<ValStat<PrfSealedMaster>> => {
      try {
        const [sealedMaster, sst] = await this.#sealUnderPrf(prf);
        if (sst !== Status.Success) return err(sst);
        return ok({
          sealedMaster,
          salt: salt.slice(),
          credId: evCredId.slice(),
          userId: created?.userId === undefined
            ? undefined
            : created.userId.slice(),
          attachment: evAttachment ?? created?.attachment,
          transports: evTransports ?? created?.transports,
          aaguid: created?.aaguid === undefined
            ? undefined
            : created.aaguid.slice(),
        });
      } finally {
        prf.fill(0);
      }
    };

    if (createPrf !== undefined && created !== undefined) {
      return finish(
        createPrf,
        created.credId,
        created.attachment,
        created.transports,
      );
    }

    const [ev, est] = await evalPrf({
      rpId: opts?.rpId,
      rpName: opts?.rpName,
      credId,
      salt,
      hints: opts?.hints,
    });
    if (est !== Status.Success) return err(est);
    if (ev === undefined) return err(Status.MissingBody);
    return finish(ev.prf, ev.credId, ev.attachment, ev.transports);
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
    const credIds: Uint8Array[] = [];
    for (const w of bindings) {
      if (w.credId.byteLength > 0) credIds.push(w.credId);
    }
    const [ev, est] = await evalPrf({
      rpId: opts.rpId,
      rpName: opts.rpName,
      hints: opts.hints,
      credId: credIds.length > 0 ? credIds : undefined,
      salt: opts.salt,
    });
    if (est !== Status.Success) return err(est);
    if (ev === undefined) return err(Status.MissingBody);
    const hit = bindings.find((w) => bytesEqual(w.credId, ev.credId));
    const order = hit === undefined
      ? bindings
      : [hit, ...bindings.filter((w) => w !== hit)];
    try {
      for (const w of order) {
        const [enclave] = await Enclave.#unsealUnderPrf(
          w.sealedMaster,
          ev.prf,
        );
        if (enclave !== undefined) {
          return ok({ enclave, credId: ev.credId.slice() });
        }
      }
      return err(Status.DecryptionError);
    } finally {
      ev.prf.fill(0);
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
    const ttyPath = "/dev/tty";
    // Non-literal: deno must not load npm:@types/node for this file.
    const fsSpec = "node:fs";
    const asciiSpc = 32;
    const asciiHash = 35;
    const asciiZero = 48;
    const asciiLcA = 87; // 'a' - 10
    const asciiLf = 10;
    const asciiCr = 13;
    const asciiEsc = 27;
    const asciiLbrack = 91;
    const asciiRbrack = 93;
    const asciiA = 65;
    const asciiK = 75;
    const nibbleMask = 15;
    const hexLines = 8;
    const bytesPerLine = 4;
    const hexGroup = 2; // bytes (4 hex chars) before the space
    const pfxLen = 3; // `n] `
    const hexBody = 9; // 4 hex + space + 4 hex
    const rowLen = pfxLen + hexBody;
    const chkLen = 13; // `#] ` + 4 hex + space + 4 hex + LF
    const chkBytes = 4;
    const blankAfter = 3; // last line of first half, if not paced
    // CSI: up 1, erase line, CR — drops the hex line after Enter echo.
    const erasePrev = new Uint8Array([
      asciiEsc,
      asciiLbrack,
      asciiZero + 1,
      asciiA,
      asciiEsc,
      asciiLbrack,
      asciiZero + 2,
      asciiK,
      asciiCr,
    ]);
    const hexDigit = (nib: number) =>
      nib < 10 ? asciiZero + nib : asciiLcA + nib;

    let fsMod: unknown;
    try {
      fsMod = await import(fsSpec);
    } catch {
      return Status.NotImplemented;
    }
    if (fsMod === null || typeof fsMod !== "object") {
      return Status.NotImplemented;
    }
    if (
      !("openSync" in fsMod) || !("writeSync" in fsMod) ||
      !("closeSync" in fsMod)
    ) {
      return Status.NotImplemented;
    }
    const openSync = fsMod.openSync;
    const writeSync = fsMod.writeSync;
    const closeSync = fsMod.closeSync;
    const readSync = "readSync" in fsMod ? fsMod.readSync : undefined;
    if (
      typeof openSync !== "function" || typeof writeSync !== "function" ||
      typeof closeSync !== "function"
    ) {
      return Status.NotImplemented;
    }
    let outFd: unknown;
    let inFd: unknown;
    try {
      outFd = openSync.call(fsMod, ttyPath, "w");
    } catch {
      return Status.NotImplemented;
    }
    if (typeof outFd !== "number") return Status.NotImplemented;
    if (typeof readSync === "function") {
      try {
        inFd = openSync.call(fsMod, ttyPath, "r");
      } catch {
        inFd = undefined;
      }
    }
    const paced = typeof inFd === "number";
    const lineBuf = new Uint8Array(rowLen + 1);
    const chkBuf = new Uint8Array(chkLen);
    const inByte = new Uint8Array(1);
    let fprint: Uint8Array | undefined;
    try {
      const [fp, fst] = await this.fingerprint();
      if (fst !== Status.Success) return fst;
      fprint = fp;
      for (let line = 0; line < hexLines; line++) {
        let pos = 0;
        lineBuf[pos] = asciiZero + line + 1;
        pos++;
        lineBuf[pos] = asciiRbrack;
        pos++;
        lineBuf[pos] = asciiSpc;
        pos++;
        for (let bi = 0; bi < bytesPerLine; bi++) {
          if (bi === hexGroup) {
            lineBuf[pos] = asciiSpc;
            pos++;
          }
          const byt = this.#seed[line * bytesPerLine + bi];
          if (byt === undefined) return Status.InternalError;
          lineBuf[pos] = hexDigit(byt >> 4);
          pos++;
          lineBuf[pos] = hexDigit(byt & nibbleMask);
          pos++;
        }
        if (paced && typeof readSync === "function") {
          writeSync.call(fsMod, outFd, lineBuf.subarray(0, rowLen));
          lineBuf.fill(0);
          for (;;) {
            const nread = readSync.call(fsMod, inFd, inByte);
            if (typeof nread !== "number" || nread <= 0) break;
            const ch = inByte[0];
            if (ch === asciiLf) break;
            if (ch === asciiCr) {
              readSync.call(fsMod, inFd, inByte);
              break;
            }
          }
          writeSync.call(fsMod, outFd, erasePrev);
        } else {
          lineBuf[pos] = asciiLf;
          writeSync.call(fsMod, outFd, lineBuf.subarray(0, pos + 1));
          lineBuf.fill(0);
          if (line === blankAfter) {
            writeSync.call(fsMod, outFd, new Uint8Array([asciiLf]));
          }
        }
      }
      chkBuf[0] = asciiHash;
      chkBuf[1] = asciiRbrack;
      chkBuf[2] = asciiSpc;
      let chkPos = 3;
      for (let bi = 0; bi < chkBytes; bi++) {
        if (bi === hexGroup) {
          chkBuf[chkPos] = asciiSpc;
          chkPos++;
        }
        const byt = fprint[bi];
        if (byt === undefined) return Status.InternalError;
        chkBuf[chkPos] = hexDigit(byt >> 4);
        chkPos++;
        chkBuf[chkPos] = hexDigit(byt & nibbleMask);
        chkPos++;
      }
      chkBuf[chkPos] = asciiLf;
      writeSync.call(fsMod, outFd, chkBuf);
      return Status.Success;
    } catch {
      return Status.InternalError;
    } finally {
      lineBuf.fill(0);
      chkBuf.fill(0);
      inByte.fill(0);
      fprint?.fill(0);
      try {
        closeSync.call(fsMod, outFd);
      } catch {
        // ignore close fail after write
      }
      if (typeof inFd === "number") {
        try {
          closeSync.call(fsMod, inFd);
        } catch {
          // ignore
        }
      }
    }
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
    let eph: { priv: X25519Sk; pub: Uint8Array }; // ephemeral X25519 pair
    try {
      eph = await genX25519();
    } catch {
      return err(Status.CryptoError);
    }
    try {
      const [key, kst] = await pairKey(eph.priv, dhkeReq, dhkeReq, eph.pub);
      if (kst !== Status.Success) return err(kst);
      try {
        const [plainBytes, pst] = this.#encodeSeedHosts(hosts);
        if (pst !== Status.Success) return err(pst);
        try {
          const body = await encryptXSalsa20Poly1305Combined(
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
  async deriveIdentity(
    keyPath: string,
    idx = 0,
  ): Promise<ValStat<Identity>> {
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
  async fingerprint(): Promise<
    ValStat<ChildKey<typeof Purpose.Fingerprint>>
  > {
    return await deriveKey({
      parent: this.#seed,
      purpose: Purpose.Fingerprint,
      kdm: nullKDM,
    });
  }

  // Bind-tag child keyed by credId. Not a global fingerprint.
  async #bindTag(
    credId: Uint8Array,
  ): Promise<ValStat<ChildKey<typeof Purpose.BindTag>>> {
    return await deriveKey({
      parent: this.#seed,
      purpose: Purpose.BindTag,
      kdm: credId,
    });
  }

  // Constant-time match of a stored tag against this master + credId.
  async #tagMatches(
    credId: Uint8Array,
    tag: ChildKey<typeof Purpose.BindTag>,
  ): Promise<boolean> {
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

  /** AEAD-seal master under KDF(PRF). PRF must stay inside Enclave methods. */
  async #sealUnderPrf(prf: Uint8Array): Promise<ValStat<SealedMasterKey>> {
    const [key, kst] = await sealKeyFromPrf(prf);
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
    const [key, kst] = await sealKeyFromPrf(prf);
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

  async #keyFromKDM(
    kdm: Uint8Array,
  ): Promise<ValStat<ChildKey<typeof Purpose.Cipher>>> {
    return await deriveKey({
      parent: this.#seed,
      purpose: Purpose.Cipher,
      kdm,
    });
  }

  async #deriveSeed(
    keyPath: string,
    idx: number,
  ): Promise<ValStat<ChildKey<typeof Purpose.Identity>>> {
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
  child: ChildKey<typeof Purpose.Identity>,
): DerivationSeed {
  return child as Uint8Array as DerivationSeed;
}

/** Derive seal KEK from PRF IKM (null-KDM child of the bind PDK). */
export async function sealKeyFromPrf(
  prf: Uint8Array,
): Promise<ValStat<ChildKey<typeof Purpose.Bind>>> {
  if (prf.byteLength < SEAL_PRF_MIN_LEN) return err(Status.InvalidParam);
  return deriveKey({
    parent: prf,
    purpose: Purpose.Bind,
    kdm: nullKDM,
  });
}

export {
  asChildKey,
  type ChildKey,
  MASTER_SEED_LEN,
  MUSEC_MIN_LEN,
  nullKDM,
  Purpose,
  SEAL_PRF_MIN_LEN,
};

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
lockAll(PairRequest);
lockAll(PairRequest.prototype);
