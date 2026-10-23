import { Exim } from "../../shared/crypto/exim.ts";
import { hashBytes, Status } from "../../shared/consts.ts";
import { randomBytes } from "../../shared/crypto/entropy.ts";
import crypto from "../../bun/src/crypto.ts";
import {
  die,
  fidoDev,
  loadRing,
  parseLabel,
  ringPath,
  unlockRing,
  waitEnter,
} from "../keys/cli-prf.ts";

const [oldLabelArg, newLabelArg, inputFile, outputFile] = process.argv.slice(2);
if (
  oldLabelArg === undefined || newLabelArg === undefined ||
  inputFile === undefined || oldLabelArg === "-h" || oldLabelArg === "--help"
) {
  console.error(
    "Usage: bun run rekey.ts OLD_LABEL NEW_LABEL INPUT_FILE [OUTPUT_FILE]",
  );
  console.error("");
  console.error("  REKEY reads a DIPLOMATIC export and re-encrypts it under");
  console.error("  a different labeled CLI key (~/.diplomatic/<LABEL>).");
  console.error("  Each label is unlocked with a YubiKey UV (fido2-tools).");
  console.error("");
  console.error("  INPUT_FILE is the export to rekey (required).");
  console.error("  If OUTPUT_FILE is omitted, result is written to stdout.");
  console.error("  (All progress messages go to stderr.)");
  console.error("");
  console.error("Examples:");
  console.error("  bun run rekey.ts old new export.dpl rekeyed.dpl");
  console.error("  bun run rekey.ts old new export.dpl > rekeyed.dpl");
  process.exit(oldLabelArg === "-h" || oldLabelArg === "--help" ? 0 : 1);
}

const oldLabel = parseLabel(oldLabelArg);
const newLabel = parseLabel(newLabelArg);
if (oldLabel === newLabel) die("OLD_LABEL and NEW_LABEL must differ");

const oldRing = loadRing(ringPath(oldLabel));
if (oldRing === undefined) die(`no keyring for ${oldLabel}`);
const newRing = loadRing(ringPath(newLabel));
if (newRing === undefined) die(`no keyring for ${newLabel}`);

console.error(`Unlocking ${oldLabel}...`);
const oldDev = fidoDev();
console.error(`Using ${oldDev}`);
const oldEnclave = await unlockRing(oldRing, oldDev);

await waitEnter(
  `Insert the YubiKey for ${newLabel} if it is a different token, then Enter.`,
);

console.error(`Unlocking ${newLabel}...`);
const newDev = fidoDev();
console.error(`Using ${newDev}`);
const newEnclave = await unlockRing(newRing, newDev);

console.error("Reading input file...");
let input: Uint8Array;
try {
  input = new Uint8Array(await Bun.file(inputFile).arrayBuffer());
} catch (err) {
  die(`Failed to read input file ${inputFile}: ${err}`);
}
if (input.length === 0) die("Input file is empty.");
console.error(`Read ${input.length} bytes from ${inputFile}.`);

console.error("Migrating export to new master key...");
const [nonceIn, nst] = Exim.exportNonce(input);
if (nst !== Status.Success || nonceIn === undefined) {
  die(`Failed to read export nonce: ${Status[nst]}`);
}
const [keyIn, stIn] = await oldEnclave.exportKey(nonceIn);
if (stIn !== Status.Success || keyIn === undefined) {
  die(`Failed to open old export key: ${Status[stIn]}`);
}
let msgs;
try {
  const [decoded, stDec] = await Exim.decodeFile(input, crypto, keyIn);
  if (stDec !== Status.Success || decoded === undefined) {
    keyIn.fill(0);
    die(`Failed to decode: ${Status[stDec]}`);
  }
  msgs = decoded;
} finally {
  keyIn.fill(0);
}
const nonce = randomBytes(hashBytes);
const [keyOut, stOut] = await newEnclave.exportKey(nonce);
if (stOut !== Status.Success || keyOut === undefined) {
  die(`Failed to open new export key: ${Status[stOut]}`);
}
let outBytes: Uint8Array;
try {
  const [sealed, sst] = await Exim.sealExport(msgs, crypto, keyOut, nonce);
  if (sst !== Status.Success || sealed === undefined) {
    keyOut.fill(0);
    die(`Failed to migrate: ${Status[sst]}`);
  }
  outBytes = sealed;
} finally {
  keyOut.fill(0);
}

console.error("Writing rekeyed data...");
if (outputFile !== undefined && outputFile.length > 0) {
  await Bun.write(outputFile, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to ${outputFile}.`);
} else {
  await Bun.write(Bun.stdout, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to stdout.`);
}

console.error("Done.");
