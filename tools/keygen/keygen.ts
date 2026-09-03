// Generate a master seed, mix keystroke entropy, bind with YubiKey hmac-secret.

import { btoh } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import {
  CLI_RP_ID,
  cliSalt,
  collectMusec,
  defaultBindPath,
  die,
  evalHmac,
  fidoDev,
  makeHmacCred,
  saveBind,
} from "../cli-prf.ts";

const arg = process.argv[2];
if (arg === "-h" || arg === "--help") {
  console.error("Usage: bun run keygen.ts [BINDING_FILE]");
  console.error("");
  console.error("  Mix OS CSPRNG with keystroke timings into a 32-byte master,");
  console.error("  create a non-resident hmac-secret cred on the YubiKey");
  console.error("  (fido2-tools), seal the master under that PRF, write the");
  console.error("  binding (default ~/.diplomatic). Master is not printed.");
  console.error("");
  console.error("  Requires fido2-tools. Device: DIP_FIDO_DEV or first token.");
  process.exit(0);
}

const path = arg === undefined || arg.length === 0 ? defaultBindPath() : arg;

console.error("Collecting entropy...");
const musec = await collectMusec();
const [enc, est] = await Enclave.fromRandom(musec);
if (est !== Status.Success || enc === undefined) die(`enclave ${est}`);

const salt = await cliSalt();
const dev = fidoDev();
console.error(`Using ${dev}`);
const credId = makeHmacCred(dev, CLI_RP_ID);
const ikm = evalHmac(dev, CLI_RP_ID, credId, salt);
const [sealed, sst] = await enc.sealWithIkm(ikm);
if (sst !== Status.Success || sealed === undefined) die(`seal ${sst}`);
saveBind(path, {
  v: 1,
  type: "prf",
  rpId: CLI_RP_ID,
  salt,
  credId,
  sealedMaster: sealed,
});
console.error(`Wrote binding to ${path}`);
console.error(`credId ${btoh(credId)}`);
