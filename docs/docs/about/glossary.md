# Glossary

Shared terms used in code and docs. Mirrors repo-root `GLOSSARY.md` (for agents and contributors).

## msg

Short for *message*. Atomic unit of change in DIPLOMATIC: insert, update, or delete of one application object, with HLC ordering metadata. On the wire and in the archive a msg carries a complete snapshot of the object's state (not a field patch).

## ent

Short for *entity*. Application object rendered from msgs (e.g. in EntDB). Identified by `eid`. Latest msg for that `eid` (by LWW / HLC) is the current value.

## bag

As in *diplomatic bag*. Encrypted packaging of a msg for relay via untrusted hosts. Protects contents from host inspection.

## rev

Short for *revision*. Identity of an ent's latest observed state, used as the base for `update` / `delete`: `{ eid, ctr, updatedAt }`. Not a separate stored type; extracted from a loaded ent (`revFromEntity`) or a msg head (`revFromHead`). Apps pass the rev of the row they are editing so the client can build the next msg without reading the message store.

## Other abbreviations

- **kdm** — key derivation material.
- **cph** (suffix) — encrypted, e.g. `headCph`.
- **enc** (suffix) — binary-encoded, e.g. `bagEnc`. Also *encoder* (`enc` / `dec` = encoder / decoder).
- **deriv** — derivation.
- **keys** — asymmetric keypair (shorter than `keyPair`).
