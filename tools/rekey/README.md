# REKEY

REKEY takes a DIPLOMATIC export file and re-encrypts it under a different
labeled CLI master (`~/.diplomatic/<LABEL>`). Each label is unlocked with
a YubiKey UV via `tools/keys` (hmac-secret). No plaintext key files.

## Usage

`bun run rekey.ts OLD_LABEL NEW_LABEL INPUT_FILE [OUTPUT_FILE]`

- `OLD_LABEL` / `NEW_LABEL`: CLI key labels (must already exist; `gen` or
  `pair request`). Must differ.
- `INPUT_FILE`: export to rekey.
- `OUTPUT_FILE`: optional. If omitted, writes to stdout (progress on
  stderr, so `> out.dpl` works).

If the labels live on different tokens, swap when prompted.

Examples:

```
bun run rekey.ts old new export.dpl rekeyed.dpl
bun run rekey.ts old new export.dpl > rekeyed.dpl
```
