# Glossary

Also published in the docs site under About → Glossary (`docs/docs/about/glossary.md`).

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

## Other abbreviations

- **kdm** — key derivation material (public bag field; mixed with identity private key when sealing).
- **cph** (suffix) — encrypted, e.g. `headCph`.
- **enc** (suffix) — binary-encoded, e.g. `bagEnc`. Also *encoder* (`enc` / `dec` = encoder / decoder).
- **deriv** — derivation.
- **idnt** — identity (the capability handle; not “id” / identifier).
- **hostIdnt** — identity for a host path (label + index).
- **keys** — asymmetric keypair (shorter than `keyPair`); prefer **identity** when the pair must stay inside the enclave.
