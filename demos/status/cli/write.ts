import { initCLIOrPanic, loadHostOrPanic, loadSeedOrPanic, panic } from "../../../deno/src/cli.ts";
import denoMsgpack from "../../../deno/src/codec.ts";
import { Status } from "../../../shared/consts.ts";
import { hostHTTPTransport } from "../../../shared/http.ts";

const seed = loadSeedOrPanic("DIP_SEED");
const host = loadHostOrPanic("DIP_HOST");
const client = await initCLIOrPanic(seed, host, hostHTTPTransport);

const text = Deno.args[0];
if (text) {
  const body = denoMsgpack.encode(text);
  const stat = await client?.upsertSingletonSync("status", body);
  if (stat !== Status.Success) panic(`upserting message: ${Status[stat]}`);
}
