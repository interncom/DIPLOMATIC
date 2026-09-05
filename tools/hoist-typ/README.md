# HOIST-TYP

HOIST-TYP takes a DIPLOMATIC export file and rewrites each message so the
entity type lives on the msg head (`typ` varstring) instead of inside the
msgpack body. The file is re-encrypted under the same labeled CLI master
(`~/.diplomatic/<LABEL>`). Unlock with a YubiKey UV via `tools/keys`
(hmac-secret).

Reads **0.19.x** heads (`eid, off, ctr, len, hsh`) and writes **0.20**
heads (`typ` first). Use this on exports from protocol 0.19.x.

## Usage

`bun run hoist-typ.ts LABEL INPUT_FILE [OUTPUT_FILE]`

- `LABEL`: CLI key label (must already exist; `gen` or `pair request`).
- `INPUT_FILE`: export to migrate.
- `OUTPUT_FILE`: optional. If omitted, writes to stdout (progress on
  stderr, so `> out.dpl` works).

Examples:

```
bun run hoist-typ.ts home export.dpl migrated.dpl
bun run hoist-typ.ts home export.dpl > migrated.dpl
```
