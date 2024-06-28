import { initCLI } from "../../../deno/src/cli.ts";
import { Verb, type IOp } from "../../../shared/types.ts";

const client = await initCLI();

const args = Deno.args;
if (args.length < 1) {
  console.error("usage: deno run count.ts COUNT");
  Deno.exit(1);
}

const count = Number.parseInt(args[0]);
if (Number.isNaN(count)) {
  console.error("Invalid count");
  Deno.exit(1);
}

const op: IOp = {
  ts: new Date().toUTCString(),
  verb: Verb.UPSERT,
  ver: 0,
  type: "count",
  body: count,
};
await client.push(op);
