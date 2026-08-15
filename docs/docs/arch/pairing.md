# Pairing

In-person transfer of the [master seed](./keys) (and host rows) from a device that already has an [enclave](/docs/about/glossary#enclave) (**enroller**) to a fresh device (**enrollee**). After `finish`, the enrollee wraps the seed under its own WebAuthn PRF for durable storage.

This is not host sync and not the old shared-passkey `dip1:` flow. The two devices need not share a passkey.

## Flow

1. Enrollee `Enclave.pairRequest()` / `PairRequest.create()` — ephemeral X25519. Carry `dhkeReq` (32-byte public key) to the enroller (QR, audio, paste, …).
2. Enroller `enclave.pairAccept(dhkeReq, hosts)` — ephemeral X25519, ECDH, AEAD-seal seed + hosts. Carry `dhkeResp` back.
3. Enrollee `req.finish(dhkeResp)` — ECDH, decrypt, `Enclave.fromBytes`. Then `sealWithPasskey` for IDB.

Presence (looking at the other screen) is the only authentication. ECDH is unauthenticated.

## Wire

| Blob | Contents |
| --- | --- |
| `DHKEReq` | enrollee X25519 public key (32 B) |
| `DHKEResp` | `respPub` (32) ‖ XSalsa20-Poly1305 combined (24-byte nonce ‖ ct ‖ 16-byte tag) |

AEAD key:

```
S     = X25519(sk_local, peer_pub)
KEK   = blake3(S ‖ diplomatic.qrpair.v1 ‖ reqPub ‖ respPub)[0..32]
```

`reqPub` / `respPub` are bound into the KDF so the ciphertext is tied to both publics. A wrap-domain PRF KEK cannot open a pair body.

Transport is not part of the object: QR, audio, or copy-paste are encodings of these bytes. A URL hash for a system camera / deeplink must not send the payload to the app host.

## Threat model

### In scope

**Capture both DHKE blobs.** Shoulder-surf or CCTV of QRs, a recording of audio, a later copy of pasted text. The attacker has `reqPub`, `respPub`, and the AEAD blob, and may try to recover `S` offline.

**Compelled vendor X25519 keygen.** A browser vendor is forced to weaken `subtle.generateKey` (or the rest of WebCrypto X25519 key generation) so that someone with a trapdoor can compute `sk` from the public key — without controlling the user’s process. That is the attack this design is written against.

### Out of scope

**Owned client.** Malicious extension, compromised JS, debugger. After `finish` the master seed is in process memory; the page can `fetch` it. No pairing crypto helps. Same for *in-process* side channels (JS timing, cache): a process that can measure those can already read the heap.

**Backdoored `getRandomValues`.** Seeds, nonces, and pairing scalars all come from it. That sinks the whole stack, not just pairing.

**Shared-passkey pair.** If both devices can evaluate the same PRF, you can seal under `blake3(prf ‖ domain)` and skip ECDH. That is a different product (synced platform passkey). This flow is for a device that does not have that credential yet.

**Active in-person MITM.** Someone gives the enroller their own `DHKEReq`. Unauthenticated ECDH: they decrypt `DHKEResp`. The user must take the request from the enrollee in front of them.

## Approach

**Own scalar, vendor multiply, pub check.** The pairing private key is 32 clamped bytes from existing `randomBytes` (`getRandomValues`) — not `generateKey`. WebCrypto does the C multiply (`importKey` / `deriveBits`). Before we emit `DHKEReq` or `respPub`, exported pub must equal RFC 7748 `x25519Pub(sk)` (`shared/crypto/x25519.ts`). Mismatch is `CryptoError`; we never emit that pub.

We considered also checking `deriveBits` against an in-house DH. That would be a second JS bigint scalarmult on the same `sk` (255 iterations, allocations) — longer and louder than the native multiply. A nearby listener (coil whine, power, EM / TEMPEST-style) is **not** an owned client: they need no code on the device and they do not get bits in the DHKE blobs. Published acoustic attacks want many traces of heavier algorithms; one-shot X25519 is still lab-grade. Even so, we do not pay for a second JS multiply. A fake `deriveBits` fails pairing with an honest browser anyway. Residual: the **pub** check is still one JS scalarmult before the request is shown.

Same-vendor backdoor-to-backdoor is ignored.

**Existing AEAD and KDF.** XSalsa20-Poly1305 and blake3 are already used for bags and PRF wrap. No ChaCha20, no HKDF-SHA256.

**PRF after transfer, not on the wire.** The enrollee’s PRF is local to its authenticator. The enroller can use it only if (1) the enrollee puts PRF bytes (or a derived key) in `DHKEReq` — then they sit on the same blob the eavesdropper already has — or (2) both devices share the passkey, which is the other flow. A split the enroller cannot see is impossible. After `finish`, `sealWithPasskey` protects IndexedDB on the new device; it does not protect `DHKEResp` in transit.

## API

| Who | Call |
| --- | --- |
| Enrollee | `Enclave.pairRequest()` / `PairRequest.create()` → show `dhkeReq` |
| Enroller | `enclave.pairAccept(dhkeReq, hosts)` → `dhkeResp` |
| Enrollee | `req.finish(dhkeResp)` → `{ enclave, hosts }`, then `sealWithPasskey` |
| Enrollee | `req.wipe()` if the user abandons before finish |

`sk` never leaves `PairRequest` / `pairAccept`. Failed `genX25519` (RNG) is `Status.CryptoError`, not `HostError`.
