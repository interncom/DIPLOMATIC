import { initCLI } from "../../../deno/src/cli.ts";
import { Verb, type IOp } from "../../../shared/types.ts";

const client = await initCLI();

const args = Deno.args;
if (args.length < 1) {
  console.error("usage: deno run status.ts STATUS");
  Deno.exit(1);
}

const status = args[0];
const op: IOp = {
  ts: new Date().toUTCString(),
  verb: Verb.UPSERT,
  ver: 0,
  type: "status",
  body: status,
};
await client.push(op);
