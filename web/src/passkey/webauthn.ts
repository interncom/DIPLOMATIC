// Re-export shared WebAuthn plumbing (kept as stable import path for passkey/*).

export {
  asPublicKeyCredential,
  checkWebAuthn,
  copyToArrayBuffer,
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  defaultWebAuthnRpId,
  resolveWebAuthnRpId,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_PUB_KEY_PARAMS,
  webAuthnExtensionCapable,
  type WebAuthnRp,
} from "../shared/webauthn/common";
