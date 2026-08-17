# Glossary

Shared terms used in code and docs. Mirrors repo-root `GLOSSARY.md` (for agents and contributors).

## msg

Short for *message*. Atomic unit of change in DIPLOMATIC: insert, update, or delete of one application object, with HLC ordering metadata. On the wire and in the archive a msg carries a complete snapshot of the object's state (not a field patch).

## ent

Short for *entity*. Application object rendered from msgs (e.g. in EntDB). Identified by `eid`. Latest msg for that `eid` (by LWW / HLC) is the current value.

## bag

As in *diplomatic bag*. Encrypted packaging of a msg for relay via untrusted hosts. Protects contents from host inspection.

## rev

Short for *revision*. Snapshot of an ent's latest observed state, used as the base for `update` / `delete`: `{ eid, ctr, updatedAt }`. Not a separate stored type; extracted from a loaded ent (`revFromEntity`) or a msg head (`revFromHead`). Apps pass the rev of the row they are editing so the client can build the next msg without reading the message store.

## identity

Path-scoped cryptographic persona derived from the master seed via a string path and numeric index (e.g. a host label, or an export-file key label). Exposed as a frozen capability handle (`Identity`): **publicKey** (public), plus **sign** and **kdmFor**, which re-enter the enclave so the private key never leaves. Used to authenticate to hosts, seal bags, and sign export files. Not a host-specific concept—hosts are one common path among others.

In code, prefer **`idnt`** (or **`hostIdnt`** when the path is a host) over **`id` / `hostId`**, which read as “identifier” rather than “identity.”

## enclave

Boundary for master-seed access and seed-derived private material. Callers get only public results (ciphertexts, signatures, public keys, plaintext after open) and opaque capability handles (`Identity`, derived ciphers). Long-term intent is hardware-backed protection of the seed.

## ikm

Input keying material. Secret bytes fed to a KDF to derive keys — not used as a cipher key itself. Here, the 32-byte WebAuthn PRF / hmac-secret output. The enclave does `blake3(IKM ‖ diplomatic.bind.v1)` to get the KEK that seals the master.

## seal

AEAD ciphertext of the master under a KEK (`SealedMasterKey`). Verbs: **seal** / **unseal**. The blob does not name a binding key. Distinct from sealing a bag.

## binding key

WebAuthn’s **authenticator** (platform passkey or roaming security key). We do not use that word: here the device is not proving *who someone is* and confers no authorization. It only supplies IKM (PRF today; later a shard) from which a KEK is derived to seal the master. Whoever can evaluate that IKM can unseal — that is capability, not authn/authz. API fields stay `authenticatorAttachment` etc.; that is WebAuthn’s name.

## binding

Relationship that lets one binding key unseal the master. Holds a seal plus `credId` and ceremony facts (nick, dates, kind). Verbs: **bind** / **remove**. A binding contains a seal; it is not the seal.

## keyring

On-device list of bindings. Not synced.

## Other abbreviations

- **ikm** — input keying material (PRF output; see above).
- **kdm** — key derivation material (public bag field; mixed with identity private key when sealing).
- **cph** (suffix) — encrypted, e.g. `headCph`.
- **enc** (suffix) — binary-encoded, e.g. `bagEnc`. Also *encoder* (`enc` / `dec` = encoder / decoder).
- **deriv** — derivation.
- **idnt** — identity (the capability handle; not “id” / identifier).
- **hostIdnt** — identity for a host path (label + index).
- **keys** — asymmetric keypair (shorter than `keyPair`); prefer **identity** when the pair must stay inside the enclave.
