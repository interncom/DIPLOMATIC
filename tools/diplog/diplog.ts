import { initCLI } from "../../deno/src/cli.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import type { IHostConnectionInfo } from "../../shared/types.ts";
import { HTTPTransport } from "../../shared/http.ts";
import { htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";

const dipSeed = Deno.env.get("DIP_SEED");
if (!dipSeed) {
  console.error("DIP_SEED env var missing");
  Deno.exit(1);
}
const seedBytes = htob(dipSeed);
const [enclave, est] = Enclave.fromBytes(libsodiumCrypto, seedBytes);
seedBytes.fill(0);
if (est !== Status.Success || enclave === undefined) {
  console.error("DIP_SEED must be 64 hex chars (32-byte master seed)");
  Deno.exit(1);
}

const dipHost = Deno.env.get("DIP_HOST");
if (!dipHost) {
  console.error("DIP_HOST env var missing");
  Deno.exit(1);
}
const hostURL = new URL(dipHost);
const host: IHostConnectionInfo<URL> = {
  handle: hostURL,
  label: "host",
  idx: 0 };
const transport = new HTTPTransport(hostURL);

const [client, stat] = await initCLI(enclave, host, transport);
if (stat !== Status.Success) {
  console.error(`Failed to init CLI: ${stat}`);
  Deno.exit(1);
}

const [items, peekStat] = await client.peek(0);
if (peekStat !== Status.Success) {
  console.error(`Failed to peek: ${peekStat}`);
  Deno.exit(1);
}
console.log(items);
