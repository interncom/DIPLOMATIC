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
  checkWebAuthn,
  copyToArrayBuffer,
  noteWebAuthnError,
  readAaguid,
  readAttachment,
  readTransports,
  resolveWebAuthnRpId,
  WEBAUTHN_CHAL_LEN,
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
  userName?: string;
  /** Omit so the UA can offer roaming keys (YubiKey) and third-party providers. */
  authenticatorAttachment?: "platform" | "cross-platform";
  /** Seal salt (eval is on get, not create — some UAs throw on create-time eval). */
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

  let cred: Credential | null;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
        rp: { id: rpId, name: opts?.rpName ?? "DIPLOMATIC" },
        user: {
          id: userId,
          name,
          displayName: name,
        },
        pubKeyCredParams: WEBAUTHN_PUB_KEY_PARAMS,
        authenticatorSelection: selection,
        extensions: { prf: {} },
        ...(opts?.hints !== undefined ? { hints: opts.hints } : {}),
        ...(opts?.excludeCredentials !== undefined &&
            opts.excludeCredentials.length > 0
          ? {
            excludeCredentials: opts.excludeCredentials.map((id) => ({
              type: "public-key" as const,
              id: copyToArrayBuffer(id),
            })),
          }
          : {}),
      },
    });
  } catch (e) {
    noteWebAuthnError(e);
    return err(Status.WebAuthnError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const ext = pk.getClientExtensionResults() as {
    prf?: { enabled?: boolean };
  };
  return ok({
    credId: new Uint8Array(pk.rawId),
    userId: new Uint8Array(userId),
    prfEnabled: ext.prf?.enabled === true,
    attachment: readAttachment(pk.authenticatorAttachment),
    transports: readTransports(pk),
    aaguid: readAaguid(pk),
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
      type: "public-key" as const,
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
    attachment: readAttachment(pk.authenticatorAttachment),
    transports: readTransports(pk),
  });
}
