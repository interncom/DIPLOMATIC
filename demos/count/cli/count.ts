import { initCLI } from "../../../deno/src/cli.ts";
import type { IHostConnectionInfo, IMessage, IMsgEntBody, MasterSeed } from "../../../shared/types.ts";
import { HTTPTransport } from "../../../shared/http.ts";
import { IEntityID, makeEID } from "../../../shared/codecs/eid.ts";
import { htob } from "../../../shared/binary.ts";
import { Status } from "../../../shared/consts.ts";
import libsodiumCrypto from "../../../deno/src/crypto.ts";
import denoMsgpack from "../../../deno/src/codec.ts";
import { genSingletonUpsert } from "../../../shared/message.ts";
import { Clock } from "../../../shared/clock.ts";

const dipSeed = Deno.env.get("DIP_SEED");
if (!dipSeed) {
  console.error("DIP_SEED env var missing");
  Deno.exit(1);
}
const seedBytes = htob(dipSeed);
if (seedBytes.length !== 32) {
  console.error("DIP_SEED must be 64 hex chars (32 bytes)");
  Deno.exit(1);
}
const seed = seedBytes as MasterSeed;

const dipHost = Deno.env.get("DIP_HOST");
if (!dipHost) {
  console.error("DIP_HOST env var missing");
  Deno.exit(1);
}
const hostURL = new URL(dipHost);
const host: IHostConnectionInfo<URL> = {
  handle: hostURL,
  label: "count",
  idx: 0,
};
const transport = new HTTPTransport(hostURL);

const [client, stat] = await initCLI(seed, host, transport);
if (stat !== Status.Success) {
  console.error(`Failed to init CLI: ${stat}`);
  Deno.exit(1);
}

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

const type = "count";
const op: IMsgEntBody = {
  type,
  body: count,
};
const content = denoMsgpack.encode(op);
const [msg, statMsg] = await genSingletonUpsert(type, new Clock(), content);
if (statMsg !== Status.Success) {
  console.error(`generating msg: ${Status[statMsg]}`);
  Deno.exit(1);
}

const [items, statPush] = await client.push([msg]);
if (statPush !== Status.Success) {
  console.error(`Failed to push to host: ${statPush}`);
  Deno.exit(1);
}
