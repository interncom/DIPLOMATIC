// WebAuthn PRF extension I/O (platform and roaming binding keys). Not crypto of
// the master seed — that stays in Enclave. Fixed module (not pluggable). PRF
// output must not be returned to app code; only Enclave consumes it for
// seal/unseal.
// WebAuthn “authenticator” = binding key: IKM only, not authn/authz.

import { Status } from "../consts.ts";
import { randomBytesArrayBuffer } from "../crypto/entropy.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import {
  asPublicKeyCredential,
  type AuthenticatorAttachmentName,
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
  webAuthnExtensionCapable,
  type WebAuthnHint,
  type WebAuthnRp,
} from "./common.ts";

type ReqOpts = PublicKeyCredentialRequestOptions & {
  hints?: WebAuthnHint[];
};

export type PrfRp = WebAuthnRp;

export type PrfCreateOpts = PrfRp & {
  /** WebAuthn user.name — stable account id. */
  userName?: string;
  /** WebAuthn user.displayName — human nick. */
  displayName?: string;
  /** Omit so the UA can offer roaming keys (YubiKey) and third-party providers. */
  authenticatorAttachment?: "platform" | "cross-platform";
  /** PRF salt. Tried at create; some UAs only eval on get(). */
  salt?: Uint8Array;
  /** Already-bound cred ids so create does not assert an existing key. */
  excludeCredentials?: readonly Uint8Array[];
};

/** Default salt for DIPLOMATIC PRF eval (UTF-8). */
export const DEFAULT_PRF_SALT = new TextEncoder().encode("diplomatic.prf.v1");

/** Default WebAuthn user.name / displayName when none is supplied. */
export const DEFAULT_PRF_USER_NAME = "diplomatic-prf";

/** Bytes of PRF output we consume (first N of `results.first`). */
export const PRF_OUTPUT_LEN = 32;

/** Public ceremony facts (no PRF bytes). */
export type PrfCeremony = {
  credId: Uint8Array;
  userId?: Uint8Array;
  attachment?: AuthenticatorAttachmentName;
  transports?: string[];
  aaguid?: Uint8Array;
};

export type PrfCreateResult = PrfCeremony & {
  prfEnabled: boolean;
  /** Present when the UA evaluated PRF during create (no second get). */
  prf?: Uint8Array;
};

/** Internal: PRF output + cred id. For Enclave only — do not re-export to apps. */
export type PrfEvalResult = PrfCeremony & {
  prf: Uint8Array;
};

export type PrfEvalOpts = PrfRp & {
  /** One id, or every bound id so a spare key can assert in one get(). */
  credId?: Uint8Array | readonly Uint8Array[];
  salt?: Uint8Array;
};

function credIdList(
  id: Uint8Array | readonly Uint8Array[] | undefined,
): Uint8Array[] {
  if (id === undefined) return [];
  if (id instanceof Uint8Array) return [id];
  return id.filter((c) => c.byteLength > 0);
}

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
    navigator.credentials.create({
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
  const publicKey: ReqOpts = {
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
    cred = await navigator.credentials.get({ publicKey });
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
