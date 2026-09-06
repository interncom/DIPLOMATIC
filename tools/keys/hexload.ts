// Paper restore: read 8×8 hex from the TTY, bind first YubiKey.

import { readFileSync } from "node:fs";
import readline from "node:readline";
import { btoh, htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import {
  Enclave,
  FP_MODE,
  MASTER_SEED_LEN,
} from "../../shared/crypto/enclave.ts";
import { NobleCrypto } from "../../shared/crypto/noble.ts";
import {
  die,
  loadRing,
  parseKeyArgs,
  persistNewLabel,
  ringPath,
} from "./cli-prf.ts";

const NEED = MASTER_SEED_LEN * 2;
const noble = new NobleCrypto();

const argv = process.argv.slice(2);
if (
  argv.includes("-h") || argv.includes("--help") || argv.length === 0 ||
  argv.every((a) => a === "--non-resident")
) {
  console.error(
    "Usage: bun run tools/keys/hexload.ts LABEL [--non-resident]",
  );
  console.error("");
  console.error("  Read paper hex (`n] xxxx xxxx` lines), Enclave.fromBytes,");
  console.error("  bind the plugged YubiKey. Prompts `n] ` one line at a");
  console.error("  time (previous line erased), then shows `#]` to check");
  console.error("  against hexdump. Whitespace ignored.");
  console.error("  Writes ~/.diplomatic/LABEL. Refuses if that file exists");
  console.error("  (use bind.ts to add a token).");
  process.exit(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
}

const { label, resident } = parseKeyArgs(argv);
const path = ringPath(label);
if (loadRing(path) !== undefined) {
  die(`${path} exists; use bind.ts ${label} to add a YubiKey`);
}

const seed = await readPaperHex();
try {
  const [enc, est] = Enclave.fromBytes(seed);
  if (est !== Status.Success || enc === undefined) die(`enclave ${est}`);
  await persistNewLabel(enc, label, resident);
} finally {
  seed.fill(0);
}

// Pull seed hex from paper lines. Non-hex ignored; # lines skipped.
function parsePaper(text: string): string {
  let hex = "";
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith("#")) continue;
    let start = 0;
    const brack = t.indexOf("]");
    if (brack >= 0 && brack <= 2) start = brack + 1;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (ch === undefined || hex.length >= NEED) continue;
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
  }
  return hex;
}

// Paper hex from stdin (prompt on stderr if that is a TTY).
async function readPaperHex(): Promise<Uint8Array> {
  const chunks: string[] = [];
  if (!process.stdin.isTTY) {
    chunks.push(readFileSync(0, "utf8"));
  } else {
    console.error("Type each `xxxx xxxx` after the `n] ` prompt, then Enter.");
    const erasePrev = "\x1b[1A\x1b[2K\r";
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      await new Promise<void>((resolve) => {
        const showPfx = (n: number) => {
          rl.setPrompt(`${n}] `);
          rl.prompt();
        };
        const onLine = (l: string) => {
          chunks.push(l);
          process.stderr.write(erasePrev);
          const got = parsePaper(chunks.join("\n")).length;
          if (got >= NEED) {
            rl.off("line", onLine);
            resolve();
            return;
          }
          showPfx(Math.floor(got / 8) + 1);
        };
        rl.on("line", onLine);
        showPfx(1);
      });
    } finally {
      rl.close();
    }
  }
  const hex = parsePaper(chunks.join("\n"));
  if (hex.length !== NEED) {
    die(`need ${NEED} hex chars, got ${hex.length}`);
  }
  const bytes = htob(hex);
  if (bytes.byteLength !== MASTER_SEED_LEN) die("bad paper hex length");
  // Must match Enclave.#fingerprint (BLAKE3 KDF, same context).
  const fp = await noble.blake3(bytes, { context: FP_MODE });
  const got = btoh(fp.subarray(0, 4));
  fp.fill(0);
  const grp = got.slice(0, 4) + " " + got.slice(4);
  console.error(`#] ${grp}`);
  console.error("Check that against the #] line on your paper, then continue.");
  return bytes;
}
