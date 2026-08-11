// Re-export shared WebAuthn plumbing (kept as stable import path for passkey/*).

export {
  asPublicKeyCredential,
  checkWebAuthn,
  copyToArrayBuffer,
  defaultWebAuthnRpId,
  resolveWebAuthnRpId,
  webAuthnExtensionCapable,
  COSE_ALG_EDDSA,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_PUB_KEY_PARAMS,
  type WebAuthnRp,
} from "../shared/webauthn/common";
