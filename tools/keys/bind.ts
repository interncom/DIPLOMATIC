// Add a YubiKey hmac-secret binding to an existing labeled keyring.

import { btoh } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import {
  die,
  evalHmac,
  fidoDev,
  loadRing,
  makeHmacCred,
  parseLabel,
  ringPath,
  unlockRing,
  upsertEntry,
  waitEnter,
  writeRing,
} from "./cli-prf.ts";

const arg = process.argv[2];
if (arg === undefined || arg === "-h" || arg === "--help") {
  console.error("Usage: bun run tools/keys/bind.ts LABEL");
  console.error("");
  console.error("  Unlock ~/.diplomatic/LABEL with a bound YubiKey, then");
  console.error("  create a hmac-secret cred on the token to add (swap when");
  console.error("  prompted). Same master; extra binding.");
  process.exit(arg === "-h" || arg === "--help" ? 0 : 1);
}

const label = parseLabel(arg);
const path = ringPath(label);
const ring = loadRing(path);
if (ring === undefined) die(`no keyring at ${path} (gen.ts ${label} first)`);

const unlockDev = fidoDev();
console.error(`Unlocking with ${unlockDev}`);
const enc = await unlockRing(ring, unlockDev);
await waitEnter("Insert the YubiKey to bind, then Enter.");

const dev = fidoDev();
console.error(`Using ${dev}`);
const credId = makeHmacCred(dev, ring.rpId);
const ikm = evalHmac(dev, ring.rpId, credId, ring.salt);
const [sealed, sst] = await enc.sealWithIkm(ikm);
if (sst !== Status.Success || sealed === undefined) die(`seal ${sst}`);
upsertEntry(ring, { type: "prf", credId, sealedMaster: sealed });
writeRing(path, ring);
console.error(`Wrote ${path} (${ring.entries.length} bindings)`);
console.error(`credId ${btoh(credId)}`);
