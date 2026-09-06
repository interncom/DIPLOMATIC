// Paper backup: unlock LABEL, write 8×8 hex master to /dev/tty.
// Re-execs with DIP_CLI_DUMP=true (Enclave.dumpToTty is fail-closed otherwise).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Status } from "../../shared/consts.ts";
import {
  die,
  fidoDev,
  loadRing,
  parseKeyArgs,
  ringPath,
  unlockRing,
} from "./cli-prf.ts";

declare const DIP_CLI_DUMP: boolean | undefined;

// Opt in to dumpToTty for this process (fail-closed in Enclave without it).
function ensureDump(): void {
  if (typeof DIP_CLI_DUMP !== "undefined" && DIP_CLI_DUMP) return;
  const r = spawnSync(
    process.execPath,
    [
      "--define",
      "DIP_CLI_DUMP=true",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
if (
  argv.includes("-h") || argv.includes("--help") || argv.length === 0 ||
  argv.every((a) => a === "--non-resident")
) {
  console.error("Usage: bun run tools/keys/hexdump.ts LABEL");
  console.error("");
  console.error("  Unlock ~/.diplomatic/LABEL with a bound YubiKey, then");
  console.error("  print `n] xxxx xxxx` plus a # check, one line at a time");
  console.error("  (Enter for next; previous line is erased).");
  process.exit(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
}

ensureDump();
const { label } = parseKeyArgs(argv);
const path = ringPath(label);
const ring = loadRing(path);
if (ring === undefined) die(`no keyring at ${path} (gen.ts ${label} first)`);

const dev = fidoDev();
console.error(`Unlocking with ${dev}`);
const enc = await unlockRing(ring, dev);
console.error("Write each `n] xxxx xxxx` line, then Enter. Previous line clears.");
const st = await enc.dumpToTty();
if (st !== Status.Success) die(`dumpToTty ${Status[st]} (${st})`);
