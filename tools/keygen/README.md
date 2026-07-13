# KEYGEN

KEYGEN generates a cryptographically secure random 256-bit master key
(32 bytes) and outputs it as a 64-character lowercase hex string to stdout.

It is intended to be piped into a file for use as a DIPLOMATIC master seed
(e.g. `DIP_SEED` or keys for REKEY etc.). The output includes a trailing
newline (common for such tools); consumers typically trim it.

## Usage

`bun run keygen.ts > KEY_FILE`

Examples:

  bun run keygen.ts > master.key
  bun run keygen.ts > ~/.config/diplomatic/master.key

The resulting file can be used directly with other tools, e.g.:

  DIP_SEED=$(cat master.key) bun run ...

Or with REKEY etc. that accept key files.
