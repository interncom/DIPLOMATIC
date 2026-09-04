// WebAuthn PRF types, defaults, and capability probe.
// PRF eval/create lives in enclave.ts — PRF output is IKM that unseals a
// binding and must not leave that file.
// WebAuthn “authenticator” = binding key: IKM only, not authn/authz.

import {
  type AuthenticatorAttachmentName,
  webAuthnExtensionCapable,
  type WebAuthnRp,
} from "./common.ts";

export type PrfRp = WebAuthnRp & {
  /** WebAuthn user.name — stable account id shown on the binding key. */
  userName?: string;
};

export type PrfCreateOpts = PrfRp & {
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

/** Last-resort WebAuthn user.name when the app omits userName, rpId, and rpName. */
export const DEFAULT_PRF_USER_NAME = "diplomatic-prf";

/** Public ceremony facts (no PRF bytes). */
export type PrfCeremony = {
  credId: Uint8Array;
  userId?: Uint8Array;
  attachment?: AuthenticatorAttachmentName;
  transports?: string[];
  aaguid?: Uint8Array;
};

export type PrfEvalOpts = PrfRp & {
  /** One id, or every bound id so a spare key can assert in one get(). */
  credId?: Uint8Array | readonly Uint8Array[];
  salt?: Uint8Array;
};

/** Best-effort: client advertises PRF extension. */
export async function prfCapable(): Promise<boolean> {
  return webAuthnExtensionCapable("extension:prf");
}
