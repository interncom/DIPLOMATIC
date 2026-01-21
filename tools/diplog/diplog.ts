import { initCLI } from "../../deno/src/cli.ts";

const client = await initCLI();

const t0 = new Date(0);
const headers = await client.peek(t0);
console.log(headers.length);
