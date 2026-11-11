// Sends one status message. Nothing is stored on disk.

import {
  initCLIOrPanic,
  loadEnclaveOrPanic,
  loadHostOrPanic,
  Status,
} from "../../../cli/src/index.ts";

const enclave = loadEnclaveOrPanic("DIP_SEED");
const host = loadHostOrPanic("DIP_HOST");
const client = await initCLIOrPanic({ enclave, host });

const text = process.argv[2];
if (!text) {
  console.error("usage: bun run write.ts <MESSAGE>");
  process.exit(1);
}

const body = new TextEncoder().encode(text);
const stat = await client.upsertSingletonSync("status", body);
if (stat !== Status.Success) {
  console.error(`upserting message: ${Status[stat]}`);
  process.exit(1);
}
