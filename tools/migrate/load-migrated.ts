// Migrates exports from legacy format to v0.1 file format.

import libsodiumCrypto from "../../deno/src/crypto.ts";
import { htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/enclave.ts";
import { decodeFile } from "../../shared/exim.ts";
import { MasterSeed } from "../../shared/types.ts";

const filename = Deno.args[0];
if (!filename) {
  console.error("usage: deno run --allow-read --allow-env=DIPLOMATIC_SEED load-migrated.ts FILENAME");
  Deno.exit(1);
}

const seedHex = await Deno.env.get("DIPLOMATIC_SEED");
if (!seedHex) {
  console.error("Must set DIPLOMATIC_SEED to hex encoded seed");
  Deno.exit(1);
}
const seed = htob(seedHex.trim());
const enclave = new Enclave(seed as MasterSeed, libsodiumCrypto);

const dpl = await Deno.readFile(filename);
console.time("Decoding...")
const [msgs, stat] = await decodeFile(dpl, libsodiumCrypto, enclave);
console.timeEnd("Decoding...")
if (stat !== Status.Success) {
  console.error("Reading export", stat);
} else {
  console.log("Loaded messages", msgs.length);
}
