// Paper restore: read 8×8 hex from the TTY, bind first YubiKey.

import { readFileSync } from "node:fs";
import readline from "node:readline";
import { htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave, MASTER_SEED_LEN } from "../../shared/crypto/enclave.ts";
import {
  die,
  loadRing,
  parseKeyArgs,
  persistNewLabel,
  ringPath,
} from "./cli-prf.ts";

const LINES = 8;
const COLS = 8;
const HEX_LINE = /^[0-9a-fA-F]{8}$/;

const argv = process.argv.slice(2);
if (
  argv.includes("-h") || argv.includes("--help") || argv.length === 0 ||
  argv.every((a) => a === "--non-resident")
) {
  console.error(
    "Usage: bun run tools/keys/hexload.ts LABEL [--non-resident]",
  );
  console.error("");
  console.error("  Read 8 lines of 8 hex chars (paper backup) from the");
  console.error("  terminal, Enclave.fromBytes, bind the plugged YubiKey.");
  console.error("  Discoverable cred by default. Writes ~/.diplomatic/LABEL.");
  console.error("  Refuses if that file exists (use bind.ts to add a token).");
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

// 8 lines of 8 hex chars from stdin (prompt on stderr if that is a TTY).
async function readPaperHex(): Promise<Uint8Array> {
  const rows: string[] = [];
  if (!process.stdin.isTTY) {
    const raw = readFileSync(0, "utf8");
    for (const l of raw.split(/\r?\n/)) {
      const t = l.trim();
      if (t.length === 0) continue;
      rows.push(t);
    }
  } else {
    console.error(`Paste ${LINES} lines of ${COLS} hex chars, then Enter.`);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      while (rows.length < LINES) {
        const line = await new Promise<string>((resolve) => {
          rl.once("line", (l) => resolve(l.trim()));
        });
        if (line.length === 0) continue;
        rows.push(line);
      }
    } finally {
      rl.close();
    }
  }
  if (rows.length !== LINES) {
    die(`need ${LINES} lines of ${COLS} hex chars, got ${rows.length}`);
  }
  let hex = "";
  for (const row of rows) {
    if (!HEX_LINE.test(row)) {
      die(`each line must be ${COLS} hex chars, got ${JSON.stringify(row)}`);
    }
    hex += row;
  }
  const bytes = htob(hex);
  if (bytes.byteLength !== MASTER_SEED_LEN) die("bad paper hex length");
  return bytes;
}
