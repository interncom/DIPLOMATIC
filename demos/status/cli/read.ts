// Prints the newest status message from the host. Nothing is stored on disk.

import {
  initCLIOrPanic,
  loadEnclaveOrPanic,
  loadHostOrPanic,
  Status,
} from "../../../cli/src/index.ts";

function panic(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const enclave = loadEnclaveOrPanic("DIP_SEED");
const host = loadHostOrPanic("DIP_HOST");
const client = await initCLIOrPanic({ enclave, host });

const [peekItems, statPeek] = await client.peek(0);
if (statPeek !== Status.Success) panic(`Failed to peek: ${Status[statPeek]}`);
if (peekItems.length < 1) panic("No result");

let peekItem = peekItems[0];
if (peekItem === undefined) panic("No result");
for (const item of peekItems) {
  if (item.seq > peekItem.seq) peekItem = item;
}

const [pullItems, statPull] = await client.pull([peekItem.seq]);
if (statPull !== Status.Success) panic(`Failed to pull: ${Status[statPull]}`);
if (pullItems.length < 1) panic("No result");

const [bag, statBag] = await client.open(peekItem, pullItems[0]);
if (statBag !== Status.Success) panic(`Opening bag: ${Status[statBag]}`);
const body = bag?.bod;
if (body) {
  const text = new TextDecoder().decode(body);
  console.log(text);
}
