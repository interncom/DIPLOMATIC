import {
  initCLIOrPanic,
  loadHostOrPanic,
  loadSeedOrPanic,
  panic,
  denoMsgpack,
  Status,
  hostHTTPTransport,
} from "../../../cli/src/index.ts";

const seed = loadSeedOrPanic("DIP_SEED");
const host = loadHostOrPanic("DIP_HOST");
const client = await initCLIOrPanic(seed, host, hostHTTPTransport);

const text = Deno.args[0];
if (text) {
  const body = denoMsgpack.encode(text);
  const stat = await client?.upsertSingletonSync("status", body);
  if (stat !== Status.Success) panic(`upserting message: ${Status[stat]}`);
}
