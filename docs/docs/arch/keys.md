# Key Management

The only long-term secret is a 32-byte **master seed**. Host identities, bag keys, and export signatures are derived from it inside the [enclave](/docs/about/glossary#enclave). After unlock, that seed lives in process memory (and in the sync Worker). WebAuthn is used to *wrap or store* the seed at rest — not to keep it out of the browser while the app is running.

Credentials are scoped to the page hostname (`rpId`). Every wrap, unwrap, and largeBlob I/O requires user verification (platform biometric / PIN, or security-key PIN + touch).

## Mechanisms

### PRF wrap (daily unlock)

WebAuthn `prf` (CTAP2 `hmac-secret`) produces 32 bytes of IKM. The enclave domain-separates those bytes (`diplomatic.wrap.v1`) and AEAD-seals under XSalsa20-Poly1305. The ciphertext plus salt and credential id sit in protocol IndexedDB. Without a successful `prf` evaluation, the blob is useless. Pairing uses a different KDF (`diplomatic.qrpair.v1`); see [Pairing](./pairing).

`createPrfCred` defaults to a **platform** authenticator (iCloud Keychain, Google Password Manager, Windows Hello). The platform vendor may sync that passkey — and therefore the ability to evaluate PRF — with the user’s account. That is accepted: the OS or browser already sees the unlocked seed in memory.

Create must report `prf.enabled`. Eval must return 32 bytes. Otherwise seal/unseal fails closed (`HostError` / `MissingBody`). There is no passphrase-seal fallback yet.

App API: `Enclave.sealWithPasskey` / `unsealWithPasskey`, `PrfSeedStore`. Probe: `prfCapable()` (browser advertises the extension; not a guarantee the authenticator has hmac-secret).

### largeBlob (offline backup)

WebAuthn `largeBlob` stores an **IdentityBundle** (seed + host rows) or a legacy bare 32-byte seed on the authenticator. The write is not PRF-wrapped. UV and `rpId` are the gate. This is not a confidentiality boundary against the OS or against anyone who can complete UV on a stolen key.

Create requires `largeBlob.support = "required"`. Attachment is not defaulted — pass `cross-platform` for a security key. Platform authenticators generally do not implement largeBlob.

App API: `Enclave.persistToLargeBlob` / `fromLargeBlob` / `clearLargeBlob`. Probe: `largeBlobCapable()`.

### Pairing (QR)

In-person seed transfer to a device that does not share a passkey. See [Pairing](./pairing) for the request/response flow, threat model, and why the X25519 scalar is ours (`getRandomValues`) rather than `subtle.generateKey`.

App API: `Enclave.pairRequest` / `PairRequest`, `enclave.pairAccept`, then `sealWithPasskey` on the enrollee.

### Raw import

`Enclave.fromBytes` (web hex paste, CLI `DIP_SEED`). No WebAuthn. Session-only unless the app then wraps with PRF or writes largeBlob.

## Platform support

Tables are current as of August 2026. Always test the target browser; `prf.enabled` / `largeBlob.supported` are the source of truth.

### Platform passkeys (PRF)

| Environment | PRF | Notes |
| --- | --- | --- |
| macOS 15+ Safari 18+, Chrome | yes | iCloud Keychain |
| iOS / iPadOS 18+ Safari | yes | iCloud Keychain |
| Android Chrome | yes | Google Password Manager |
| Windows 11 + Chrome/Edge 147+, Firefox 148+ | yes | Windows Hello |

Platform passkeys do **not** provide largeBlob. Use a roaming key for IdentityBundle backup.

### Roaming authenticators (YubiKey and similar)

The token must implement the CTAP extension **and** the OS/browser must pass extension data to it.

| Environment | PRF | largeBlob |
| --- | --- | --- |
| Windows 11 Chrome, Edge, Firefox (USB) | yes | yes |
| macOS Chrome (USB) | yes | yes |
| macOS Safari | no | no |
| Android Chrome USB | yes | yes |
| Android Chrome NFC | no | no |
| iOS / iPadOS (any browser) | no | no |

iOS/iPadOS does not pass WebAuthn extension I/O to external keys. Chrome on iOS is WebKit, so the same limit applies. On those devices, use the platform passkey for PRF; keep the YubiKey for desktop backup.

### Which YubiKeys

| Feature | Hardware |
| --- | --- |
| `hmac-secret` / PRF | YubiKey 5 Series and Bio (firmware 5.2+); Security Key Series (FIDO2) |
| largeBlob | Firmware **5.5+** (1 KiB); **5.7+** (4 KiB). Newer Security Key Series (5.7+) included. |

Firmware is printed in Yubico Authenticator. Keys cannot be upgraded. Prefer 5.7+ if the bundle will carry many host rows.

Other CTAP2.1 keys with hmac-secret and/or largeBlob work the same way when the platform forwards extensions. We do not require attestation, so a software passkey and a YubiKey are not distinguished in code.

## Choosing a path

| Goal | Use |
| --- | --- |
| Unlock this browser next visit | PRF wrap → protocol IDB |
| Move identity to another device in person | QR pair (`pairRequest` / `pairAccept`), then PRF wrap on the new device |
| Survive a wiped profile / new machine without cloud passkeys | largeBlob on a YubiKey (desktop), then optional PRF bind |
| CLI / tests | Raw seed |

A typical app (see LIFE): platform PRF for daily unlock; optional `cross-platform` largeBlob write as a YubiKey backup; QR pair for a second device. On iPhone, only the platform PRF path is available after the pair.
