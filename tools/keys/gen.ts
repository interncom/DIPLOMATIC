// New labeled master: musec mix, bind first YubiKey, write ~/.diplomatic/<LABEL>.

import { btoh } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import {
  CLI_RP_ID,
  cliSalt,
  collectMusec,
  die,
  evalHmac,
  fidoDev,
  loadRing,
  makeHmacCred,
  parseKeyArgs,
  ringPath,
  upsertEntry,
  writeRing,
} from "./cli-prf.ts";

const argv = process.argv.slice(2);
if (
  argv.includes("-h") || argv.includes("--help") ||
  argv.every((a) => a === "--non-resident")
) {
  console.error("Usage: bun run tools/keys/gen.ts LABEL [--non-resident]");
  console.error("");
  console.error("  Mix musec, Enclave.fromRandom, bind the plugged YubiKey");
  console.error("  (hmac-secret). Discoverable cred by default (Authenticator,");
  console.error("  one RK slot). --non-resident: no RK. Writes");
  console.error("  ~/.diplomatic/LABEL. Refuses if that file exists");
  console.error("  (use bind.ts to add a token).");
  process.exit(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
}

const { label, resident } = parseKeyArgs(argv);
const path = ringPath(label);
if (loadRing(path) !== undefined) {
  die(`${path} exists; use bind.ts ${label} to add a YubiKey`);
}

console.error("Collecting entropy...");
const musec = await collectMusec();
const [enc, est] = await Enclave.fromRandom(musec);
if (est !== Status.Success || enc === undefined) die(`enclave ${est}`);

const salt = await cliSalt();
const ring = { v: 2 as const, rpId: CLI_RP_ID, salt, entries: [] };
const dev = fidoDev();
console.error(`Using ${dev}`);
const credId = makeHmacCred(dev, ring.rpId, { resident, userName: label });
const ikm = evalHmac(dev, ring.rpId, credId, ring.salt);
const [sealed, sst] = await enc.sealWithIkm(ikm);
if (sst !== Status.Success || sealed === undefined) die(`seal ${sst}`);
upsertEntry(ring, { type: "prf", credId, sealedMaster: sealed, resident });
writeRing(path, ring);
console.error(`Wrote ${path}`);
console.error(`credId ${btoh(credId)}`);
