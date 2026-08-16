// Shared WebAuthn plumbing (RP id, challenges, credential checks, capability probes).

import { Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";

export const WEBAUTHN_CHAL_LEN = 32;

/** COSE algorithm identifiers for WebAuthn `pubKeyCredParams`. */
export const COSE_ALG_ES256 = -7; // ECDSA w/ SHA-256 (P-256)
export const COSE_ALG_EDDSA = -8; // EdDSA (Ed25519)
export const COSE_ALG_RS256 = -257; // RSASSA-PKCS1-v1_5 w/ SHA-256

/** Prefer modern curves; include RS256 for broader authenticator coverage. */
export const WEBAUTHN_PUB_KEY_PARAMS: PublicKeyCredentialParameters[] = [
  { type: "public-key", alg: COSE_ALG_ES256 },
  { type: "public-key", alg: COSE_ALG_EDDSA },
  { type: "public-key", alg: COSE_ALG_RS256 },
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
    cred.type !== "public-key" ||
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
