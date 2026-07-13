# REKEY

REKEY takes a DIPLOMATIC export file and reencrypts it with a new master key.

The old and new master keys are read from files (paths are provided on the
command line) so the secret material never appears in shell history.

## Usage

`bun run rekey.ts OLDKEY_FILE NEWKEY_FILE INPUT_FILE [OUTPUT_FILE]`

- `OLDKEY_FILE`: file containing the current 64-hex-char master key.
- `NEWKEY_FILE`: file containing the new 64-hex-char master key.
- `INPUT_FILE` (required): the export file to rekey.
- `OUTPUT_FILE` (optional): destination. If omitted, writes to stdout
  (progress messages always go to stderr, so `> out.dpl` works).

Progress messages are emitted for each major step:
reading key files, reading input, decrypting, re-encrypting, writing.

Examples:

  bun run rekey.ts old.key new.key export.dpl rekeyed.dpl
  bun run rekey.ts old.key new.key export.dpl > rekeyed.dpl
