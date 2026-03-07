import { initCLI } from "../../deno/src/cli.ts";
import type { IHostConnectionInfo, IMessage, MasterSeed } from "../../shared/types.ts";
import { HTTPTransport } from "../../shared/http.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import libsodiumCrypto from "../../deno/src/crypto.ts";

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
  label: "dipcat",
  idx: 0,
};
const transport = new HTTPTransport(hostURL);

const [client, stat] = await initCLI(seed, host, transport);
if (stat !== Status.Success) {
  console.error(`Failed to init CLI: ${stat}`);
  Deno.exit(1);
}

const chunks: Uint8Array[] = [];
for await (const chunk of Deno.stdin.readable) {
  chunks.push(chunk);
}
if (chunks.length === 0) {
  console.error("No input provided over STDIN");
  Deno.exit(1);
}
const blob = new Blob(chunks as BlobPart[]);
const arrayBuffer = await blob.arrayBuffer();
const content = new Uint8Array(arrayBuffer);

const [eid, statEID] = makeEID({
  id: await libsodiumCrypto.genRandomBytes(16),
  ts: new Date(),
});
if (statEID !== Status.Success) {
  console.error(`Failed to make EID: ${statEID}`);
  Deno.exit(1);
}
const msg: IMessage = {
  eid,
  off: 0,
  ctr: 0,
  len: content.length,
  bod: content,
};

const [items, statPush] = await client.push([msg]);
if (statPush !== Status.Success) {
  console.error(`Failed to push to host: ${statPush}`);
  Deno.exit(1);
}
