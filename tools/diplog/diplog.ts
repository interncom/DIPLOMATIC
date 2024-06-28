import { initCLI } from "../../deno/src/cli.ts";

const client = await initCLI();

const t0 = new Date(0);
const resp = await client.list(t0);
const paths = resp?.paths ?? [];
for (const path of paths) {
  const op = await client.pull(path);
  if (op) {
    console.log(op);
  }
}
