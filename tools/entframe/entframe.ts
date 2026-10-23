// Rewrites a pre-v0.24 export so ent bodies use the ent frame.

import { decode, encode } from "@msgpack/msgpack";
import { btoh, bytesEqual } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { Exim } from "../../shared/crypto/exim.ts";
import crypto from "../../bun/src/crypto.ts";
import {
  die,
  fidoDev,
  loadRing,
  parseLabel,
  ringPath,
  unlockRing,
} from "../keys/cli-prf.ts";
import { checksumEntInfo, entFrameMsgs } from "./migrate.ts";

const [labelArg, inputFile, outputFile] = process.argv.slice(2);
if (
  labelArg === undefined || inputFile === undefined ||
  labelArg === "-h" || labelArg === "--help"
) {
  console.error(
    "Usage: bun run entframe.ts LABEL INPUT_FILE [OUTPUT_FILE]",
  );
  console.error("");
  console.error("  Rewrites a pre-v0.24 DIPLOMATIC export onto the ent frame.");
  console.error(
    "  Old msgpack { body, pid?, tags?, type? } becomes pid, tags,",
  );
  console.error("  and a msgpack application body. type moves to the head");
  console.error("  when the head typ is empty.");
  console.error(
    "  Refuses to write if the ent information checksum changes.",
  );
  console.error("  Unlock LABEL with a YubiKey UV (same as tools/rekey).");
  console.error("");
  console.error("  INPUT_FILE is the export to migrate (required).");
  console.error("  If OUTPUT_FILE is omitted, result is written to stdout.");
  console.error("");
  console.error("Examples:");
  console.error("  bun run entframe.ts LIFE export.dpl framed.dpl");
  console.error("  bun run entframe.ts LIFE export.dpl > framed.dpl");
  process.exit(labelArg === "-h" || labelArg === "--help" ? 0 : 1);
}

const label = parseLabel(labelArg);
const ring = loadRing(ringPath(label));
if (ring === undefined) die(`no keyring for ${label}`);

console.error(`Unlocking ${label}...`);
const dev = fidoDev();
console.error(`Using ${dev}`);
const enclave = await unlockRing(ring, dev);

console.error("Reading input file...");
let input: Uint8Array;
try {
  input = new Uint8Array(await Bun.file(inputFile).arrayBuffer());
} catch (e) {
  die(`Failed to read input file ${inputFile}: ${e}`);
}
if (input.length === 0) die("Input file is empty.");
console.error(`Read ${input.length} bytes from ${inputFile}.`);

const [nonce, nst] = Exim.exportNonce(input);
if (nst !== Status.Success || nonce === undefined) {
  die(`Failed to read export nonce: ${Status[nst]}`);
}
const [key, kst] = await enclave.exportKey(nonce);
if (kst !== Status.Success || key === undefined) {
  die(`Failed to open export key: ${Status[kst]}`);
}

console.error("Decoding export...");
const [realms, stDec] = await Exim.decodeFile(input, crypto, key);
if (stDec !== Status.Success || realms === undefined) {
  key.fill(0);
  die(`Failed to decode: ${Status[stDec]}`);
}

const pack = { encode, decode };
const hash = (data: Uint8Array) => crypto.blake3(data);
const before = [];
for (const part of realms) {
  for (const msg of part.msgs) before.push(msg);
}
console.error(`Checking ${before.length} messages...`);
const [sum0, st0] = await checksumEntInfo(before, hash, pack);
if (st0 !== Status.Success || sum0 === undefined) {
  key.fill(0);
  die(`Failed to checksum: ${Status[st0]}`);
}

console.error(`Migrating ${before.length} messages...`);
const next = [];
for (const part of realms) {
  const [framed, stMig] = await entFrameMsgs(part.msgs, hash, pack);
  if (stMig !== Status.Success || framed === undefined) {
    key.fill(0);
    die(`Failed to migrate: ${Status[stMig]}`);
  }
  next.push({ realm: part.realm, msgs: framed });
}
const after = [];
for (const part of next) {
  for (const msg of part.msgs) after.push(msg);
}
const [sum1, st1] = await checksumEntInfo(after, hash, pack);
if (st1 !== Status.Success || sum1 === undefined) {
  key.fill(0);
  die(`Failed to checksum migrated data: ${Status[st1]}`);
}
if (!bytesEqual(sum0, sum1)) {
  key.fill(0);
  die(`Info checksum mismatch ${btoh(sum0)} ${btoh(sum1)}`);
}
console.error(`Info checksum ${btoh(sum0)}.`);

console.error("Encoding export...");
const [outBytes, stEnc] = await Exim.encodeFile(next, crypto, key, nonce);
key.fill(0);
if (stEnc !== Status.Success || outBytes === undefined) {
  die(`Failed to encode: ${Status[stEnc]}`);
}

console.error("Writing migrated data...");
if (outputFile !== undefined && outputFile.length > 0) {
  await Bun.write(outputFile, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to ${outputFile}.`);
} else {
  await Bun.write(Bun.stdout, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to stdout.`);
}

console.error("Done.");
