// WebAuthn PRF extension I/O (platform passkeys). Not crypto of the master seed —
// that stays in Enclave. Fixed module (not pluggable). PRF output must not be
// returned to app code; only Enclave consumes it for seal/unseal.

import { Status } from "../consts.ts";
import { randomBytesArrayBuffer } from "../crypto/entropy.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import {
  asPublicKeyCredential,
  checkWebAuthn,
  copyToArrayBuffer,
  resolveWebAuthnRpId,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_PUB_KEY_PARAMS,
  webAuthnExtensionCapable,
  type WebAuthnRp,
} from "./common.ts";

export type PrfRp = WebAuthnRp;

export type PrfCreateOpts = PrfRp & {
  userName?: string;
  authenticatorAttachment?: string;
};

/** Default salt for DIPLOMATIC PRF eval (UTF-8). */
export const DEFAULT_PRF_SALT = new TextEncoder().encode("diplomatic.prf.v1");

/** Bytes of PRF output we consume (first N of `results.first`). */
export const PRF_OUTPUT_LEN = 32;

export type PrfCreateResult = {
  credId: Uint8Array;
  prfEnabled: boolean;
};

/** Internal: PRF output + cred id. For Enclave only — do not re-export to apps. */
export type PrfEvalResult = {
  prf: Uint8Array;
  credId: Uint8Array;
};

export type PrfEvalOpts = PrfRp & {
  credId?: Uint8Array;
  salt?: Uint8Array;
};

/** Best-effort: client advertises PRF extension. */
export async function prfCapable(): Promise<boolean> {
  return webAuthnExtensionCapable("extension:prf");
}

/** Create a discoverable credential that enables PRF. */
export async function createPrfCred(
  opts?: PrfCreateOpts,
): Promise<ValStat<PrfCreateResult>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return err(rst);
  if (rpId === undefined) return err(Status.MissingParam);

  const name = opts?.userName ?? "diplomatic-prf";
  const selection: AuthenticatorSelectionCriteria = {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "required",
    authenticatorAttachment: (opts?.authenticatorAttachment ??
      "platform") as AuthenticatorAttachment,
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
        extensions: { prf: {} },
      },
    });
  } catch {
    return err(Status.HostError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const ext = pk.getClientExtensionResults() as {
    prf?: { enabled?: boolean };
  };
  return ok({
    credId: new Uint8Array(pk.rawId),
    prfEnabled: ext.prf?.enabled === true,
  });
}

/**
 * Evaluate PRF (UV). Returns PRF bytes — only Enclave should call this and must
 * zero/drop PRF after seal/unseal. Apps must not hold PRF alongside sealed meta.
 */
export async function evalPrf(
  opts?: PrfEvalOpts,
): Promise<ValStat<PrfEvalResult>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return err(rst);
  if (rpId === undefined) return err(Status.MissingParam);

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
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const results = (
    pk.getClientExtensionResults() as {
      prf?: { results?: { first?: BufferSource } };
    }
  ).prf?.results;
  if (results?.first === undefined) return err(Status.MissingBody);

  const first = results.first;
  const raw = first instanceof ArrayBuffer
    ? new Uint8Array(first)
    : new Uint8Array(
      (first as ArrayBufferView).buffer,
      (first as ArrayBufferView).byteOffset,
      (first as ArrayBufferView).byteLength,
    );
  const prf = raw.byteLength >= PRF_OUTPUT_LEN
    ? raw.slice(0, PRF_OUTPUT_LEN)
    : raw;
  if (prf.byteLength !== PRF_OUTPUT_LEN) return err(Status.InvalidResponse);
  return ok({
    prf,
    credId: new Uint8Array(pk.rawId),
  });
}
