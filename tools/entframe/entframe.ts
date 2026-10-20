// Rewrites a pre-v0.24 export so ent bodies use the ent frame.

import { decode, encode } from "@msgpack/msgpack";
import { btoh, bytesEqual } from "../../shared/binary.ts";
import { Decoder } from "../../shared/codec.ts";
import { fileCodec } from "../../shared/codecs/file.ts";
import { Status } from "../../shared/consts.ts";
import { nullKDM } from "../../shared/crypto/derivation.ts";
import { Exim } from "../../shared/exim.ts";
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

const [fileStruct, stFile] = fileCodec.decode(new Decoder(input));
if (stFile !== Status.Success) {
  die(`Failed to read export head: ${Status[stFile]}`);
}
const idKDM = { label: fileStruct.head.lbl, index: fileStruct.head.idx };
const [bagMgr, stBag] = await enclave.bagman(idKDM, nullKDM);
if (stBag !== Status.Success) {
  die(`Failed to open export key: ${Status[stBag]}`);
}

console.error("Decoding export...");
const [msgs, stDec] = await Exim.decodeFile(input, crypto, bagMgr);
if (stDec !== Status.Success) die(`Failed to decode: ${Status[stDec]}`);

const pack = { encode, decode };
const hash = (data: Uint8Array) => crypto.blake3(data);
console.error(`Checking ${msgs.length} messages...`);
const [sum0, st0] = await checksumEntInfo(msgs, hash, pack);
if (st0 !== Status.Success || sum0 === undefined) {
  die(`Failed to checksum: ${Status[st0]}`);
}

console.error(`Migrating ${msgs.length} messages...`);
const [next, stMig] = await entFrameMsgs(msgs, hash, pack);
if (stMig !== Status.Success || next === undefined) {
  die(`Failed to migrate: ${Status[stMig]}`);
}
const [sum1, st1] = await checksumEntInfo(next, hash, pack);
if (st1 !== Status.Success || sum1 === undefined) {
  die(`Failed to checksum migrated data: ${Status[st1]}`);
}
if (!bytesEqual(sum0, sum1)) {
  die(`Info checksum mismatch ${btoh(sum0)} ${btoh(sum1)}`);
}
console.error(`Info checksum ${btoh(sum0)}.`);

console.error("Encoding export...");
const [outBytes, stEnc] = await Exim.encodeFile(next, crypto, bagMgr);
if (stEnc !== Status.Success) die(`Failed to encode: ${Status[stEnc]}`);

console.error("Writing migrated data...");
if (outputFile !== undefined && outputFile.length > 0) {
  await Bun.write(outputFile, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to ${outputFile}.`);
} else {
  await Bun.write(Bun.stdout, outBytes);
  console.error(`Wrote ${outBytes.length} bytes to stdout.`);
}

console.error("Done.");
