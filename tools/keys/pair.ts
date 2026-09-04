// Enroller DHKE: unlock labeled CLI keyring, emit dhkeResp hex.

import { readFileSync } from "node:fs";
import readline from "node:readline";
import { btoh, htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { NobleCrypto } from "../../shared/crypto/noble.ts";
import { asDHKEReq } from "../../shared/crypto/pairing.ts";
import {
  die,
  fidoDev,
  loadRing,
  parseLabel,
  ringPath,
  unlockRing,
} from "./cli-prf.ts";

function usage(code: number): never {
  console.error("Usage: bun run tools/keys/pair.ts LABEL [DHKEREQ_HEX]");
  console.error("");
  console.error("  Unlock ~/.diplomatic/LABEL with a YubiKey UV, accept the");
  console.error("  enrollee DHKEReq (64 hex chars), print DHKEResp hex.");
  console.error("  Progress and PIN prompts go to stderr.");
  process.exit(code);
}

const a0 = process.argv[2];
const a1 = process.argv[3];
if (a0 === "-h" || a0 === "--help") usage(0);
if (a0 === undefined) usage(1);

const label = parseLabel(a0);
const path = ringPath(label);
let reqHex: string | undefined;
if (a1 !== undefined && a1.length > 0) reqHex = a1;

/** Which X25519 step threw (pairAccept swallows this into CryptoError). */
async function noteDhkeErr(peer: Uint8Array): Promise<void> {
  const n = new NobleCrypto();
  try {
    const eph = await n.genX25519();
    try {
      const s = await n.x25519Shared(eph.priv, peer);
      s.fill(0);
      console.error("genX25519 and x25519Shared succeeded on retry");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`x25519Shared: ${msg}`);
    } finally {
      eph.priv.fill(0);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`genX25519: ${msg}`);
  }
}

/** Read one line from stdin; prompt on stderr if that is a TTY. */
async function readReq(): Promise<string> {
  if (!process.stdin.isTTY) {
    return readFileSync(0, "utf8").trim();
  }
  console.error("Paste DHKEReq hex, then Enter.");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const line = await new Promise<string>((resolve) => {
    rl.once("line", (l) => {
      rl.close();
      resolve(l.trim());
    });
  });
  return line;
}

if (reqHex === undefined) reqHex = await readReq();
const hex = reqHex.replace(/\s+/g, "");
if (!/^[0-9a-fA-F]{64}$/.test(hex)) die("DHKEReq must be 64 hex characters");

const [dhkeReq, qst] = asDHKEReq(htob(hex));
if (qst !== Status.Success || dhkeReq === undefined) die(`DHKEReq ${qst}`);

const ring = loadRing(path);
if (ring === undefined) die(`no keyring at ${path}`);
const dev = fidoDev();
console.error(`Using ${dev}`);
const enc = await unlockRing(ring, dev);
const [resp, ast] = await enc.pairAccept(dhkeReq, []);
if (ast !== Status.Success || resp === undefined) {
  if (ast === Status.CryptoError) await noteDhkeErr(dhkeReq);
  die(`pairAccept ${Status[ast]} (${ast})`);
}
process.stdout.write(btoh(resp) + "\n");
