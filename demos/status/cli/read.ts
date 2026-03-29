import * as Diplomatic from "@interncom/diplomatic-cli";
const { Status } = Diplomatic;

function panic(msg: string) {
  console.error(msg);
  process.exit(1);
}

const seed = Diplomatic.loadSeedOrPanic("DIP_SEED");
const host = Diplomatic.loadHostOrPanic("DIP_HOST");
const client = await Diplomatic.initCLIOrPanic({ seed, host });

const [peekItems, statPeek] = await client.peek(0);
if (statPeek !== Status.Success) panic(`Failed to peek: ${statPeek}`);
if (peekItems.length < 1) panic(`No result`);

let peekItem = peekItems[0];
for (const item of peekItems) {
  if (item.seq > peekItem.seq) peekItem = item;
}

const [pullItems, statPull] = await client.pull([peekItem.seq]);
if (statPull !== Status.Success) panic(`Failed to pull: ${statPull}`);
if (pullItems.length < 1) panic(`No result`);

const [bag, statBag] = await client.open(peekItem, pullItems[0]);
if (statBag !== Status.Success) panic(`Opening bag: ${statBag}`);
const body = bag?.bod;
if (body) {
  const text = Diplomatic.msgpack.decode(body);
  console.log(text);
}
