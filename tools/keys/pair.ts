// DHKE pair: request (enrollee) or accept (enroller).

import { createReadStream, readFileSync } from "node:fs";
import readline from "node:readline";
import { btoh, htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { NobleCrypto } from "../../shared/crypto/noble.ts";
import { asDHKEReq, asDHKEResp, DHKE_RESP_MIN } from "../../shared/crypto/pairing.ts";
import {
  die,
  fidoDev,
  loadRing,
  parseKeyArgs,
  persistNewLabel,
  ringPath,
  unlockRing,
} from "./cli-prf.ts";

function usage(code: number): never {
  console.error("Usage:");
  console.error("  bun run tools/keys/pair.ts request LABEL [--non-resident]");
  console.error("  bun run tools/keys/pair.ts accept LABEL [DHKEREQ_HEX]");
  console.error("");
  console.error("  request: enrollee. Print DHKEReq, read DHKEResp, bind");
  console.error("  the plugged YubiKey (new ~/.diplomatic/LABEL).");
  console.error("  accept: enroller. Confirm both devices, unlock LABEL,");
  console.error("  print DHKEResp.");
  process.exit(code);
}

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
async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return readFileSync(0, "utf8").trim();
  }
  console.error(prompt);
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

/** One line from the controlling TTY (not a pipe). */
async function readTtyLine(prompt: string): Promise<string> {
  console.error(prompt);
  const tty = createReadStream("/dev/tty");
  const rl = readline.createInterface({ input: tty });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once("line", (l) => resolve(l.trim()));
      tty.once("error", reject);
    });
  } catch {
    die("pair accept needs a TTY to confirm you control both devices");
  } finally {
    rl.close();
    tty.destroy();
  }
}

// Returns true only after the user types yes on the TTY.
async function ackBothSides(): Promise<true> {
  const line = await readTtyLine(
    "Confirm you control both devices in this pairing. Type yes:",
  );
  if (line.toLowerCase() !== "yes") {
    die("aborted (type yes if you control both devices)");
  }
  return true;
}

async function runRequest(label: string, resident: boolean): Promise<void> {
  const path = ringPath(label);
  if (loadRing(path) !== undefined) {
    die(`${path} exists; use bind.ts ${label} to add a YubiKey`);
  }
  const [req, rst] = await Enclave.pairRequest();
  if (rst !== Status.Success || req === undefined) die(`pairRequest ${rst}`);
  const reqHex = btoh(req.dhkeReq);
  console.error("DHKEReq (paste into the other device):");
  process.stdout.write(reqHex + "\n");
  const raw = await readLine("Paste DHKEResp hex, then Enter.");
  const hex = raw.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < DHKE_RESP_MIN * 2) {
    req.wipe();
    die(`DHKEResp must be at least ${DHKE_RESP_MIN * 2} hex characters`);
  }
  const [dhkeResp, vst] = asDHKEResp(htob(hex));
  if (vst !== Status.Success || dhkeResp === undefined) {
    req.wipe();
    die(`DHKEResp ${vst}`);
  }
  const [opened, ost] = await req.finish(dhkeResp);
  if (ost !== Status.Success || opened === undefined) {
    die(`finish ${Status[ost]} (${ost})`);
  }
  await persistNewLabel(opened.enclave, label, resident);
}

async function runAccept(label: string, reqHex: string | undefined): Promise<void> {
  const path = ringPath(label);
  if (reqHex === undefined) {
    reqHex = await readLine("Paste DHKEReq hex, then Enter.");
  }
  const hex = reqHex.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) die("DHKEReq must be 64 hex characters");
  const [dhkeReq, qst] = asDHKEReq(htob(hex));
  if (qst !== Status.Success || dhkeReq === undefined) die(`DHKEReq ${qst}`);

  const userControlsBothSidesOfPair = await ackBothSides();
  const ring = loadRing(path);
  if (ring === undefined) die(`no keyring at ${path}`);
  const dev = fidoDev();
  console.error(`Using ${dev}`);
  const enc = await unlockRing(ring, dev);
  const [resp, ast] = await enc.pairAccept(dhkeReq, [], {
    userControlsBothSidesOfPair,
  });
  if (ast !== Status.Success || resp === undefined) {
    if (ast === Status.CryptoError) await noteDhkeErr(dhkeReq);
    die(`pairAccept ${Status[ast]} (${ast})`);
  }
  process.stdout.write(btoh(resp) + "\n");
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
  usage(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
}
const verb = argv[0];
if (verb !== "request" && verb !== "accept") usage(1);

if (verb === "request") {
  const { label, resident } = parseKeyArgs(argv.slice(1));
  if (label.length === 0) usage(1);
  await runRequest(label, resident);
} else {
  const rest = argv.slice(1);
  const a0 = rest[0];
  const a1 = rest[1];
  if (a0 === undefined) usage(1);
  const label = parseKeyArgs([a0]).label;
  let reqHex: string | undefined;
  if (a1 !== undefined && a1.length > 0) reqHex = a1;
  await runAccept(label, reqHex);
}
