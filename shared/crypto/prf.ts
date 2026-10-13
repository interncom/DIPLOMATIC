// WebAuthn PRF eval/create, plus the binding types Enclave returns.
// sealPRF and unsealPRF return the PRF value to Enclave, which seals,
// unseals, and wipes those bytes. bind's tag checks stay on Enclave.
// Only enclave.ts may call these.

import { btob64url, bytesEqual } from "../binary.ts";
import { Status } from "../consts.ts";
import type { SealedMasterKey } from "../seed.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { type PDK } from "./derivation.ts";
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
  /** PRF salt for this cred. Omitted salts use the ceremony salt. */
  salt?: Uint8Array;
};

/** Durable PRF-sealed master + public ceremony facts (never includes PRF output). */
export type PrfSealedMaster = PrfCeremony & {
  sealedMaster: SealedMasterKey;
  salt: Uint8Array;
};

/** One existing keyring member used to prove this enclave matches the list. */
export type BindPrior = {
  credId: Uint8Array;
  tag: PDK["BindTag"];
};

/** Seal + bind-tag from {@link Enclave.bind} (tag is not a global fingerprint). */
export type PrfBound = PrfSealedMaster & {
  tag: PDK["BindTag"];
};

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

  const salt = opts?.salt ?? DEFAULT_PRF_SALT;
  const saltBuf = copyToArrayBuffer(salt);
  const input: AuthenticationExtensionsPRFInputs = {
    eval: { first: saltBuf },
  };
  const perCred = opts?.salts;
  if (perCred !== undefined && perCred.length > 0) {
    const byCred: Record<string, AuthenticationExtensionsPRFValues> = {};
    for (const row of perCred) {
      if (row.credId.byteLength === 0) continue;
      byCred[btob64url(row.credId)] = { first: copyToArrayBuffer(row.salt) };
    }
    input.evalByCredential = byCred;
  }
  const publicKey: PrfGetOpts = {
    challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
    rpId,
    userVerification: "preferred",
    extensions: { prf: input },
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

// UV + PRF ceremony for seal. Returns PRF output and public ceremony facts.
// Caller wipes `prf`.
export async function sealPRF(
  opts: PasskeyPrfOpts | undefined,
): Promise<ValStat<PrfCeremony & { prf: Uint8Array; salt: Uint8Array }>> {
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
    if (!c.prfEnabled) return err(Status.WebAuthnError);
    credId = c.credId;
    created = c;
    createPrf = c.prf;
  }

  const pack = (
    prf: Uint8Array,
    evCredId: Uint8Array,
    evAttachment?: PrfCeremony["attachment"],
    evTransports?: string[],
  ) =>
    ok({
      prf,
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

  if (createPrf !== undefined && created !== undefined) {
    return pack(
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
  return pack(ev.prf, ev.credId, ev.attachment, ev.transports);
}

// UV + PRF for unseal. Returns the PRF output, the asserted cred id, and
// bindings to try (matching cred first). Caller wipes `prf`.
export async function unsealPRF(
  bindings: readonly PrfBinding[],
  opts: PasskeyPrfOpts & { salt: Uint8Array },
): Promise<
  ValStat<{
    prf: Uint8Array;
    credId: Uint8Array;
    order: readonly PrfBinding[];
  }>
> {
  const credIds: Uint8Array[] = [];
  const salts: { credId: Uint8Array; salt: Uint8Array }[] = [];
  let mixed = false;
  for (const w of bindings) {
    if (w.credId.byteLength === 0) continue;
    credIds.push(w.credId);
    const salt = w.salt ?? opts.salt;
    if (!bytesEqual(salt, opts.salt)) mixed = true;
    salts.push({ credId: w.credId, salt });
  }
  const [ev, est] = await evalPrf({
    rpId: opts.rpId,
    rpName: opts.rpName,
    hints: opts.hints,
    credId: credIds.length > 0 ? credIds : undefined,
    salt: opts.salt,
    salts: mixed ? salts : undefined,
  });
  if (est !== Status.Success) return err(est);
  const match = bindings.find((w) => bytesEqual(w.credId, ev.credId));
  const order = match === undefined
    ? bindings
    : [match, ...bindings.filter((w) => w !== match)];
  return ok({ prf: ev.prf, credId: ev.credId.slice(), order });
}
