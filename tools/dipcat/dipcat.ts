import { initCLI } from "../../deno/src/cli.ts";
import { isOp } from "../../shared/ops.ts";

const client = await initCLI();

// Put op.
const buf = new Uint8Array(1024);
const num = await Deno.stdin.read(buf);
if (!num) {
  Deno.exit(1);
}
const text = new TextDecoder().decode(buf.subarray(0, num));
try {
  const op = JSON.parse(text);
  if (!isOp(op)) {
    console.error("Invalid input")
    Deno.exit(1);
  }
  await client.push(op);
} catch (err) {
  console.error("Error parsing input", err)
  Deno.exit(1);
}
