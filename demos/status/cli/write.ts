import {
  initCLIOrPanic,
  loadHostOrPanic,
  loadSeedOrPanic,
  denoMsgpack,
  Status,
  hostHTTPTransport,
} from "@interncom/diplomatic-cli";

const seed = loadSeedOrPanic("DIP_SEED");
const host = loadHostOrPanic("DIP_HOST");
const client = await initCLIOrPanic(seed, host, hostHTTPTransport);

const text = process.argv[2];
if (text) {
  const body = denoMsgpack.encode(text);
  const stat = await client.upsertSingletonSync("status", body);
  if (stat !== Status.Success) {
    console.error(`upserting message: ${Status[stat]}`);
    process.exit(1);
  }
}
