import { Exim } from "../../shared/exim.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import crypto from "../../bun/src/crypto.ts";

const [oldKeyFile, newKeyFile, inputFile, outputFile] = process.argv.slice(2);
if (!oldKeyFile || !newKeyFile || !inputFile) {
  console.error(
    "Usage: bun run rekey.ts OLDKEY_FILE NEWKEY_FILE INPUT_FILE [OUTPUT_FILE]",
  );
  console.error("");
  console.error("  REKEY reads a DIPLOMATIC export file and re-encrypts it");
  console.error("  using a new master key.");
  console.error("");
  console.error("  The old and new keys are read from files (paths provided");
  console.error("  on the command line) so that secret key material does not");
  console.error("  appear in shell history.");
  console.error("");
  console.error("  INPUT_FILE is the export to rekey (required).");
  console.error("  If OUTPUT_FILE is omitted, result is written to stdout.");
  console.error("  (All progress messages go to stderr.)");
  console.error("");
  console.error("Examples:");
  console.error("  bun run rekey.ts old.key new.key export.dpl rekeyed.dpl");
  console.error("  bun run rekey.ts old.key new.key export.dpl > rekeyed.dpl");
  process.exit(1);
}

console.error("Reading old key file...");
let oldHex: string;
try {
  oldHex = (await Bun.file(oldKeyFile).text()).trim();
} catch (err) {
  console.error(`Failed to read old key file ${oldKeyFile}: ${err}`);
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(oldHex)) {
  console.error("Old key file must contain exactly 64 hexadecimal characters.");
  process.exit(1);
}

console.error("Reading new key file...");
let newHex: string;
try {
  newHex = (await Bun.file(newKeyFile).text()).trim();
} catch (err) {
  console.error(`Failed to read new key file ${newKeyFile}: ${err}`);
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(newHex)) {
  console.error("New key file must contain exactly 64 hexadecimal characters.");
  process.exit(1);
}

console.error("Reading input file...");
let input: Uint8Array;
try {
  input = new Uint8Array(await Bun.file(inputFile).arrayBuffer());
} catch (err) {
  console.error(`Failed to read input file ${inputFile}: ${err}`);
  process.exit(1);
}
if (input.length === 0) {
  console.error("Input file is empty.");
  process.exit(1);
}
console.error(`Read ${input.length} bytes from ${inputFile}.`);

const oldBytes = htob(oldHex);
const newBytes = htob(newHex);

console.error("Decrypting with old master key...");
const [oldEnclave, oest] = Enclave.fromBytes(oldBytes);
if (oest !== Status.Success || oldEnclave === undefined) throw new Error(`old enclave ${oest}`);
const [msgs, statDec] = await Exim.decodeFile(input, crypto, oldEnclave);
if (statDec !== Status.Success) {
  console.error(`Failed to decode: ${Status[statDec]}`);
  process.exit(1);
}
console.error(`Decoded ${msgs.length} message(s).`);

console.error("Re-encrypting with new master key...");
const [newEnclave, nest] = Enclave.fromBytes(newBytes);
if (nest !== Status.Success || newEnclave === undefined) throw new Error(`new enclave ${nest}`);
const [outBytes, statEnc] = await Exim.encodeFile(
  "export",
  0,
  msgs,
  crypto,
  newEnclave,
);
if (statEnc !== Status.Success) {
  console.error(`Failed to re-encode: ${Status[statEnc]}`);
  process.exit(1);
}

console.error("Writing rekeyed data...");
if (outputFile) {
  await Bun.write(outputFile, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to ${outputFile}.`);
} else {
  await Bun.write(Bun.stdout, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to stdout.`);
}

console.error("Done.");
process.exit(0);
