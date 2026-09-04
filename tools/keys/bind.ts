// Add a YubiKey hmac-secret binding to an existing labeled keyring.

import { btoh } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import {
  die,
  evalHmac,
  fidoDev,
  loadRing,
  makeHmacCred,
  parseKeyArgs,
  ringPath,
  unlockRing,
  upsertEntry,
  waitEnter,
  writeRing,
} from "./cli-prf.ts";

const argv = process.argv.slice(2);
if (
  argv.includes("-h") || argv.includes("--help") ||
  argv.every((a) => a === "--non-resident")
) {
  console.error("Usage: bun run tools/keys/bind.ts LABEL [--non-resident]");
  console.error("");
  console.error("  Unlock ~/.diplomatic/LABEL with a bound YubiKey, then");
  console.error("  create a hmac-secret cred on the token to add (swap when");
  console.error("  prompted). Discoverable by default. Same master.");
  process.exit(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
}

const { label, resident } = parseKeyArgs(argv);
const path = ringPath(label);
const ring = loadRing(path);
if (ring === undefined) die(`no keyring at ${path} (gen.ts ${label} first)`);

const unlockDev = fidoDev();
console.error(`Unlocking with ${unlockDev}`);
const enc = await unlockRing(ring, unlockDev);
await waitEnter("Insert the YubiKey to bind, then Enter.");

const dev = fidoDev();
console.error(`Using ${dev}`);
const credId = makeHmacCred(dev, ring.rpId, { resident, userName: label });
const ikm = evalHmac(dev, ring.rpId, credId, ring.salt);
const [sealed, sst] = await enc.sealWithIkm(ikm);
if (sst !== Status.Success || sealed === undefined) die(`seal ${sst}`);
upsertEntry(ring, { type: "prf", credId, sealedMaster: sealed, resident });
writeRing(path, ring);
console.error(`Wrote ${path} (${ring.entries.length} bindings)`);
console.error(`credId ${btoh(credId)}`);
