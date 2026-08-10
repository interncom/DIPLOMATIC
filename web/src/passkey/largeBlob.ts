// WebAuthn largeBlob: raw bytes, 32-byte master seeds, and IdentityBundle backups.
// Not a confidentiality boundary vs the OS — only vs hosts / casual disk.
// Logical errors return Status / ValStat; browser UV cancel maps to HostError.

import { Decoder, Encoder } from "../shared/codec";
import {
  type IdentityBundle,
  identityBundleCodec,
} from "../shared/codecs/identityBundle";
import { Status } from "../shared/consts";
import { randomBytesArrayBuffer } from "../shared/crypto/entropy";
import { asMasterSeed, MASTER_SEED_LEN, type MasterSeed } from "../shared/seed";
import { err, ok, type ValStat } from "../shared/valstat";
import {
  asPublicKeyCredential,
  checkWebAuthn,
  copyToArrayBuffer,
  resolveWebAuthnRpId,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_PUB_KEY_PARAMS,
  webAuthnExtensionCapable,
  type WebAuthnRp,
} from "./webauthn";

/** RP options for largeBlob ceremonies ({@link WebAuthnRp}). */
export type LargeBlobRp = WebAuthnRp;

export type LargeBlobCreateOpts = LargeBlobRp & {
  userName?: string;
  /**
   * Omit (default) to allow both platform (Hello/Touch ID) and roaming
   * authenticators (YubiKey). Set only if you intentionally restrict.
   */
  authenticatorAttachment?: AuthenticatorAttachment;
};

export type LargeBlobUnlock = {
  seed: MasterSeed;
  /** Authenticator credential id — app should persist for faster local unlock. */
  credId: Uint8Array;
};

function rpIdOf(opts?: LargeBlobRp): ValStat<string> {
  return resolveWebAuthnRpId(opts);
}

async function readAssertion(
  credId: Uint8Array | undefined,
  opts?: LargeBlobRp,
): Promise<ValStat<{ blob: Uint8Array; credId: Uint8Array }>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = rpIdOf(opts);
  if (rst !== Status.Success || rpId === undefined) return err(rst);

  let cred: Credential | null;
  try {
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
      rpId,
      userVerification: "required",
      extensions: { largeBlob: { read: true } },
    };
    if (credId !== undefined) {
      publicKey.allowCredentials = [
        { type: "public-key", id: copyToArrayBuffer(credId) },
      ];
    }
    cred = await navigator.credentials.get({ publicKey });
  } catch {
    return err(Status.HostError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success || pk === undefined) return err(pst);
  const blob = pk.getClientExtensionResults().largeBlob?.blob;
  if (blob === undefined) return err(Status.MissingBody);
  return ok({
    blob: new Uint8Array(blob),
    credId: new Uint8Array(pk.rawId),
  });
}

function seedUnlockFromBlob(
  seedBytes: Uint8Array,
  credId: Uint8Array,
): ValStat<LargeBlobUnlock> {
  // Wiped credentials store 32 zero bytes — treat as empty.
  if (seedBytes.every((b) => b === 0)) return err(Status.MissingSeed);
  const [seed, sst] = asMasterSeed(seedBytes);
  if (sst !== Status.Success || seed === undefined) return err(sst);
  return ok({ seed, credId });
}

/**
 * WebAuthn largeBlob helpers. Errors are Status / ValStat (no thrown logical errors).
 *
 * @example
 * ```ts
 * if (await LargeBlob.capable()) {
 *   const [credId, st] = await LargeBlob.createCred({ userName: "backup" });
 *   if (st !== Status.Success || credId === undefined) return st;
 *   const wst = await LargeBlob.write(credId, bytes);
 * }
 * ```
 */
export const LargeBlob = {
  /** Best-effort capability probe (not all UAs expose this). */
  capable(): Promise<boolean> {
    return webAuthnExtensionCapable("extension:largeBlob");
  },

  /**
   * Create a discoverable credential with largeBlob support.
   * Does not write data — call {@link LargeBlob.write} / {@link LargeBlob.writeSeed} next.
   *
   * Default allows platform *and* cross-platform authenticators. Forcing
   * `authenticatorAttachment: "platform"` excludes YubiKeys and similar.
   */
  async createCred(
    opts?: LargeBlobCreateOpts,
  ): Promise<ValStat<Uint8Array>> {
    const wst = checkWebAuthn();
    if (wst !== Status.Success) return err(wst);
    const [rpId, rst] = rpIdOf(opts);
    if (rst !== Status.Success || rpId === undefined) return err(rst);

    const name = opts?.userName ?? "diplomatic-seed";
    const selection: AuthenticatorSelectionCriteria = {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    };
    if (opts?.authenticatorAttachment !== undefined) {
      selection.authenticatorAttachment = opts.authenticatorAttachment;
    }

    let cred: Credential | null;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
          rp: { id: rpId, name: opts?.rpName ?? "DIPLOMATIC" },
          user: {
            id: randomBytesArrayBuffer(16),
            name,
            displayName: name,
          },
          pubKeyCredParams: WEBAUTHN_PUB_KEY_PARAMS,
          authenticatorSelection: selection,
          extensions: { largeBlob: { support: "required" } },
        },
      });
    } catch {
      return err(Status.HostError);
    }

    const [pk, pst] = asPublicKeyCredential(cred);
    if (pst !== Status.Success || pk === undefined) return err(pst);
    if (pk.getClientExtensionResults().largeBlob?.supported !== true) {
      return err(Status.HostError);
    }
    return ok(new Uint8Array(pk.rawId));
  },

  /** Write arbitrary bytes to largeBlob on an existing credential. */
  async write(
    credId: Uint8Array,
    data: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<Status> {
    const wst = checkWebAuthn();
    if (wst !== Status.Success) return wst;
    const [rpId, rst] = rpIdOf(opts);
    if (rst !== Status.Success || rpId === undefined) return rst;

    let cred: Credential | null;
    try {
      cred = await navigator.credentials.get({
        publicKey: {
          challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
          rpId,
          allowCredentials: [
            { type: "public-key", id: copyToArrayBuffer(credId) },
          ],
          userVerification: "required",
          extensions: { largeBlob: { write: copyToArrayBuffer(data) } },
        },
      });
    } catch {
      return Status.HostError;
    }

    const [pk, pst] = asPublicKeyCredential(cred);
    if (pst !== Status.Success || pk === undefined) return pst;
    if (pk.getClientExtensionResults().largeBlob?.written !== true) {
      return Status.HostError;
    }
    return Status.Success;
  },

  /** Read arbitrary bytes from largeBlob on a known credential. */
  async read(
    credId: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<ValStat<Uint8Array>> {
    const [out, st] = await readAssertion(credId, opts);
    if (st !== Status.Success || out === undefined) return err(st);
    return ok(out.blob);
  },

  /** Persist a 32-byte master seed on an existing largeBlob-capable credential. */
  async writeSeed(
    credId: Uint8Array,
    seed: MasterSeed,
    opts?: LargeBlobRp,
  ): Promise<Status> {
    const [, sst] = asMasterSeed(seed);
    if (sst !== Status.Success) return sst;
    return LargeBlob.write(credId, seed, opts);
  },

  /**
   * Read seed from largeBlob on a known credential (user verification required).
   */
  async readSeed(
    credId: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<ValStat<MasterSeed>> {
    const [out, st] = await LargeBlob.unlock(credId, opts);
    if (st !== Status.Success || out === undefined) return err(st);
    return ok(out.seed);
  },

  /** Same as {@link LargeBlob.readSeed} but also returns the credential id used. */
  async unlock(
    credId: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<ValStat<LargeBlobUnlock>> {
    const [raw, st] = await readAssertion(credId, opts);
    if (st !== Status.Success || raw === undefined) return err(st);
    return seedUnlockFromBlob(raw.blob, raw.credId);
  },

  /**
   * Discoverable assertion + largeBlob read (no local credential id).
   *
   * Omits `allowCredentials` so the platform can offer resident keys for this
   * rpId — including iCloud-synced passkeys. Returns seed and `credId` so the
   * app can cache the id for later non-discoverable unlocks.
   */
  async discover(opts?: LargeBlobRp): Promise<ValStat<LargeBlobUnlock>> {
    const [raw, st] = await readAssertion(undefined, opts);
    if (st !== Status.Success || raw === undefined) return err(st);
    return seedUnlockFromBlob(raw.blob, raw.credId);
  },

  /**
   * Overwrite largeBlob with 32 zero bytes (destroys stored seed material).
   * UV required.
   */
  async clearSeed(credId: Uint8Array, opts?: LargeBlobRp): Promise<Status> {
    const [zeros, zst] = asMasterSeed(new Uint8Array(MASTER_SEED_LEN));
    if (zst !== Status.Success || zeros === undefined) return zst;
    return LargeBlob.writeSeed(credId, zeros, opts);
  },

  /**
   * Create credential and write seed (two user gestures).
   * Returns credential id — persist it (e.g. IDB); the seed lives on the authenticator.
   */
  async storeSeed(
    seed: MasterSeed,
    opts?: LargeBlobCreateOpts,
  ): Promise<ValStat<Uint8Array>> {
    const [credId, cst] = await LargeBlob.createCred(opts);
    if (cst !== Status.Success || credId === undefined) return err(cst);
    const wst = await LargeBlob.writeSeed(credId, seed, opts);
    if (wst !== Status.Success) return err(wst);
    return ok(credId);
  },

  /** Encode and write an {@link IdentityBundle}. */
  async writeBundle(
    credId: Uint8Array,
    bundle: IdentityBundle,
    opts?: LargeBlobRp,
  ): Promise<Status> {
    const enc = new Encoder();
    const st = enc.writeStruct(identityBundleCodec, bundle);
    if (st !== Status.Success) return st;
    return LargeBlob.write(credId, enc.result(), opts);
  },

  /** Read and decode an {@link IdentityBundle } from largeBlob. */
  async readBundle(
    credId: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<ValStat<IdentityBundle>> {
    const [bytes, rst] = await LargeBlob.read(credId, opts);
    if (rst !== Status.Success || bytes === undefined) return err(rst);
    const dec = new Decoder(bytes);
    return dec.readStruct(identityBundleCodec);
  },

  /**
   * Create largeBlob-capable cred and store bundle.
   * Two UV gestures if create+write are chained.
   */
  async storeBundle(
    bundle: IdentityBundle,
    opts?: LargeBlobCreateOpts,
  ): Promise<ValStat<Uint8Array>> {
    const [credId, cst] = await LargeBlob.createCred(opts);
    if (cst !== Status.Success || credId === undefined) return err(cst);
    const wst = await LargeBlob.writeBundle(credId, bundle, opts);
    if (wst !== Status.Success) return err(wst);
    return ok(credId);
  },
} as const;
