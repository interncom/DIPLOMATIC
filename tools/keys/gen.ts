// New labeled master: musec mix, bind first YubiKey, write ~/.diplomatic/<LABEL>.

import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import {
  collectMusec,
  die,
  parseKeyArgs,
  persistNewLabel,
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

console.error("Collecting entropy...");
const musec = await collectMusec();
const [enc, est] = await Enclave.fromRandom(musec);
if (est !== Status.Success || enc === undefined) die(`enclave ${est}`);
await persistNewLabel(enc, label, resident);
