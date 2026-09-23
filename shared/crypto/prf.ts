// WebAuthn PRF eval/create. Only enclave.ts may import this module.
// These functions may return PRF output; they must not receive the master
// seed. Enclave derives the seal KEK and wipes the IKM.

import { Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";
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
  DEFAULT_PRF_SALT,
  DEFAULT_PRF_USER_NAME,
  type PrfCeremony,
  type PrfCreateOpts,
  type PrfEvalOpts,
} from "../webauthn/prf.ts";

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

// Create a discoverable credential that enables PRF. Returns IKM when the
// authenticator evals during create. Only Enclave calls this.
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

// Evaluate PRF (UV). Returns IKM. Only Enclave calls this.
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
