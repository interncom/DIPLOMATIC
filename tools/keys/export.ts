// Print a one-file export key. The nonce is the KDM. The key opens only that file.

import { btoh } from "../../shared/binary.ts";
import { hashBytes, Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { randomBytes } from "../../shared/crypto/entropy.ts";
import {
  die,
  fidoDev,
  loadRing,
  parseKeyArgs,
  ringPath,
  unlockRing,
} from "./cli-prf.ts";

function usage(code: number): never {
  console.error("Usage: bun run tools/keys/export.ts LABEL");
  console.error("");
  console.error("Unlock LABEL and print nonce‖file key on stdout (128 hex).");
  console.error("The key is the export child of the master for that nonce.");
  console.error("It seals one file. The master stays in the enclave.");
  process.exit(code);
}

const { label } = parseKeyArgs(process.argv.slice(2));
if (label === "") {
  usage(process.argv.includes("-h") || process.argv.includes("--help") ? 0 : 1);
}

const path = ringPath(label);
const ring = loadRing(path);
if (ring === undefined) die(`no keyring ${path}`);

const dev = fidoDev();
console.error(`Using ${dev}`);
const enc = await unlockRing(ring, dev);
const nonce = randomBytes(hashBytes);
const [key, st] = await enc.exportKey(nonce);
if (st !== Status.Success || key === undefined) die(`export key ${Status[st]}`);
try {
  process.stdout.write(btoh(nonce) + btoh(key) + "\n");
} finally {
  key.fill(0);
}
