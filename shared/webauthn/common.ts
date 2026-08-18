// Shared WebAuthn plumbing (RP id, challenges, credential checks, capability probes).
// WebAuthn “authenticator” = our binding key: IKM source for sealing the master,
// not authentication or authorization. Keep their API names (authenticatorAttachment).

import { Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";

export const WEBAUTHN_CHAL_LEN = 32;

/** Default RP name shown in the WebAuthn picker. */
export const DEFAULT_WEBAUTHN_RP_NAME = "DIPLOMATIC";

/** WebAuthn PublicKeyCredentialType. */
export const WEBAUTHN_CRED_TYPE = "public-key" as const;

/** COSE algorithm identifiers for WebAuthn `pubKeyCredParams`. */
export const COSE_ALG_ES256 = -7; // ECDSA w/ SHA-256 (P-256)
export const COSE_ALG_EDDSA = -8; // EdDSA (Ed25519)
export const COSE_ALG_RS256 = -257; // RSASSA-PKCS1-v1_5 w/ SHA-256

/** Prefer modern curves; include RS256 for broader binding-key coverage. */
export const WEBAUTHN_PUB_KEY_PARAMS: PublicKeyCredentialParameters[] = [
  { type: WEBAUTHN_CRED_TYPE, alg: COSE_ALG_ES256 },
  { type: WEBAUTHN_CRED_TYPE, alg: COSE_ALG_EDDSA },
  { type: WEBAUTHN_CRED_TYPE, alg: COSE_ALG_RS256 },
];

/** UA preference for the WebAuthn picker. Not exclusive; omit attachment to allow both. */
export type WebAuthnHint = "security-key" | "client-device" | "hybrid";

export type WebAuthnRp = {
  rpId?: string;
  rpName?: string;
  /** Level 3 `hints`. Prefer `security-key` so Android offers USB. */
  hints?: WebAuthnHint[];
};

/**
 * Default WebAuthn RP ID: the full hostname (no eTLD+1 collapse).
 *
 * Credentials are scoped to this exact host. That is deliberate and simple —
 * no Public Suffix List, no multi-part-suffix guesses. Apps that want a shared
 * RP across subdomains (e.g. `app.example.com` + `www.example.com` →
 * `example.com`) must pass an explicit `rpId` that is a valid suffix of the
 * origin (WebAuthn requires the RP ID equal the effective domain or a
 * registrable suffix of it).
 *
 * Normalizes case and trailing dots. Empty → `"localhost"`.
 */
export function defaultWebAuthnRpId(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  return host || "localhost";
}

/**
 * Fresh standalone {@link ArrayBuffer} copy of `src`.
 * Safari (and some Chromium paths) are picky about BufferSource for
 * largeBlob write / allowCredentials id — pass a real ArrayBuffer, not a
 * view into a larger pooled buffer.
 */
export function copyToArrayBuffer(src: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out.buffer;
}

/** Copy WebAuthn blob / BufferSource into an owned Uint8Array. */
export function bufferSourceToUint8(src: BufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) {
    return new Uint8Array(src).slice();
  }
  return new Uint8Array(src.buffer, src.byteOffset, src.byteLength).slice();
}

/** Resolve RP id from opts or `location.hostname`. */
export function resolveWebAuthnRpId(opts?: WebAuthnRp): ValStat<string> {
  if (opts?.rpId !== undefined) return ok(opts.rpId);
  if (typeof location === "undefined") return err(Status.MissingParam);
  return ok(defaultWebAuthnRpId(location.hostname));
}

let lastWebAuthnErr = "";

/** Last `credentials.create`/`get` throw (name + message). Empty if none. */
export function webAuthnLastError(): string {
  return lastWebAuthnErr;
}

/** Records a WebAuthn DOMException (or other throw) for {@link webAuthnLastError}. */
export function noteWebAuthnError(e: unknown): void {
  if (e instanceof Error) {
    lastWebAuthnErr = e.message === "" ? e.name : `${e.name}: ${e.message}`;
    return;
  }
  lastWebAuthnErr = String(e);
}

/** Success if WebAuthn credentials API is available in this environment. */
export function checkWebAuthn(): Status {
  if (
    typeof navigator === "undefined" ||
    !navigator.credentials ||
    typeof PublicKeyCredential === "undefined"
  ) {
    return Status.HostError;
  }
  return Status.Success;
}

export function asPublicKeyCredential(
  cred: Credential | null,
): ValStat<PublicKeyCredential> {
  if (
    cred === null ||
    cred.type !== WEBAUTHN_CRED_TYPE ||
    !("rawId" in cred) ||
    typeof (cred as PublicKeyCredential).getClientExtensionResults !==
      "function"
  ) {
    return err(Status.InvalidResponse);
  }
  return ok(cred as PublicKeyCredential);
}

/**
 * Best-effort capability probe (not all UAs expose this).
 * `extKey` e.g. `"extension:largeBlob"`, `"extension:prf"`.
 */
export async function webAuthnExtensionCapable(
  extKey: string,
): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined") return false;
  const getCaps = PublicKeyCredential.getClientCapabilities;
  if (typeof getCaps !== "function") return true;
  const caps = await getCaps.call(PublicKeyCredential);
  if (extKey in caps) return caps[extKey] === true;
  return true;
}

export type AuthenticatorAttachmentName = "platform" | "cross-platform";

export type EnrolledOs =
  | "ios"
  | "macos"
  | "android"
  | "windows"
  | "linux"
  | "other";

/** Maps a WebAuthn attachment string to the two legal values. */
export function readAttachment(
  v: string | null | undefined,
): AuthenticatorAttachmentName | undefined {
  if (v === "platform" || v === "cross-platform") return v;
  return undefined;
}

/** Coarse OS of this browser (enrollment / display only). */
export function enrolledOsFromUA(ua: string): EnrolledOs {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "other";
}

/** `getTransports()` on an attestation response, if the UA exposes it. */
export function readTransports(
  pk: PublicKeyCredential,
): string[] | undefined {
  const resp = pk.response;
  if (!("getTransports" in resp)) return undefined;
  const fn = resp.getTransports;
  if (typeof fn !== "function") return undefined;
  const raw: unknown = fn.call(resp);
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === "string" && t.length > 0) out.push(t);
  }
  return out.length === 0 ? undefined : out;
}

const AUTH_DATA_FLAGS = 32;
const AUTH_DATA_AT = 0x40;
const AAGUID_OFF = 37;
const AAGUID_LEN = 16;

/** AAGUID from attested credential data (create). Undefined if AT is absent. */
export function readAaguid(pk: PublicKeyCredential): Uint8Array | undefined {
  const resp = pk.response;
  if (!("getAuthenticatorData" in resp)) return undefined;
  const fn = resp.getAuthenticatorData;
  if (typeof fn !== "function") return undefined;
  const raw: unknown = fn.call(resp);
  if (!(raw instanceof ArrayBuffer)) return undefined;
  const ad = new Uint8Array(raw);
  if (ad.byteLength < AAGUID_OFF + AAGUID_LEN) return undefined;
  const flags = ad[AUTH_DATA_FLAGS];
  if (flags === undefined || (flags & AUTH_DATA_AT) === 0) return undefined;
  return ad.slice(AAGUID_OFF, AAGUID_OFF + AAGUID_LEN);
}
