// WebAuthn PRF extension helpers (platform passkeys: iOS 18+ / macOS 15+ Safari/Chrome).
// Not a confidentiality boundary vs the OS — only vs hosts / casual disk.

import { Status } from "../shared/consts";
import { err, ok, type ValStat } from "../shared/valstat";
import { randomBytesArrayBuffer } from "../shared/crypto/entropy";
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

/** RP options for PRF ceremonies ({@link WebAuthnRp}). */
export type PrfRp = WebAuthnRp;

export type PrfCreateOpts = PrfRp & {
  userName?: string;
  authenticatorAttachment?: AuthenticatorAttachment;
};

/** Default salt for DIPLOMATIC PRF eval (UTF-8). */
export const DEFAULT_PRF_SALT = new TextEncoder().encode(
  "diplomatic.prf.v1",
);

/** Bytes of PRF output we consume (first N of `results.first`). */
export const PRF_OUTPUT_LEN = 32;

export type PrfCreateResult = {
  credId: Uint8Array;
  prfEnabled: boolean;
};

export type PrfEvalResult = {
  /** First {@link PRF_OUTPUT_LEN} bytes of PRF output. */
  prf: Uint8Array;
  credId: Uint8Array;
};

/** Best-effort: client advertises PRF extension. */
export async function prfCapable(): Promise<boolean> {
  return webAuthnExtensionCapable("extension:prf");
}

/**
 * Create a discoverable platform-oriented credential that enables PRF.
 * Prefer platform attachment for Apple PRF (iCloud Keychain).
 */
export async function createPrfCred(
  opts?: PrfCreateOpts,
): Promise<ValStat<PrfCreateResult>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success || rpId === undefined) return err(rst);

  const name = opts?.userName ?? "diplomatic-prf";
  const selection: AuthenticatorSelectionCriteria = {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "required",
    authenticatorAttachment: opts?.authenticatorAttachment ?? "platform",
  };

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
        extensions: {
          prf: {},
        },
      },
    });
  } catch {
    return err(Status.HostError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success || pk === undefined) return err(pst);
  const ext = pk.getClientExtensionResults();
  return ok({
    credId: new Uint8Array(pk.rawId),
    prfEnabled: ext.prf?.enabled === true,
  });
}

/**
 * Evaluate PRF on an existing (or discoverable) credential.
 * Pass `credId` when known; omit for discoverable assertion.
 */
export async function evalPrf(
  opts?: PrfRp & {
    credId?: Uint8Array;
    /** Salt for PRF first input; default {@link DEFAULT_PRF_SALT}. */
    salt?: Uint8Array;
  },
): Promise<ValStat<PrfEvalResult>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success || rpId === undefined) return err(rst);

  const salt = opts?.salt ?? DEFAULT_PRF_SALT;
  const saltBuf = copyToArrayBuffer(salt);
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
    rpId,
    userVerification: "required",
    extensions: {
      prf: {
        eval: { first: saltBuf },
      },
    },
  };
  if (opts?.credId !== undefined) {
    publicKey.allowCredentials = [
      { type: "public-key", id: copyToArrayBuffer(opts.credId) },
    ];
  }

  let cred: Credential | null;
  try {
    cred = await navigator.credentials.get({ publicKey });
  } catch {
    return err(Status.HostError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success || pk === undefined) return err(pst);
  const results = pk.getClientExtensionResults().prf?.results;
  if (results?.first === undefined) return err(Status.MissingBody);

  const first = results.first;
  const raw = first instanceof ArrayBuffer
    ? new Uint8Array(first)
    : new Uint8Array(
      first.buffer,
      first.byteOffset,
      first.byteLength,
    );
  const prf =
    raw.byteLength >= PRF_OUTPUT_LEN
      ? raw.slice(0, PRF_OUTPUT_LEN)
      : raw;
  if (prf.byteLength !== PRF_OUTPUT_LEN) return err(Status.InvalidResponse);
  return ok({
    prf,
    credId: new Uint8Array(pk.rawId),
  });
}
