# STATUS CLI

We'll make an app that syncs a text status message using DIPLOMATIC.

## Write

First, we write the message to the host.

### Steps

1. Install [bun](https://bun.com/).
2. `bun init`
3. `bun add @interncom/diplomatic-cli`
4. Create `write.ts` with the code below. We'll explain this line-by-line in the next section.

```ts
import * as Diplomatic from "@interncom/diplomatic-cli";

const seed = Diplomatic.loadSeedOrPanic("DIP_SEED");
const host = Diplomatic.loadHostOrPanic("DIP_HOST");
const client = await Diplomatic.initCLIOrPanic({ seed, host });

const text = process.argv[2];
if (!text) {
  console.error(`usage: bun run write.ts <MESSAGE>`);
  process.exit(1);
}

const body = Diplomatic.msgpack.encode(text);
const stat = await client.upsertSingletonSync("status", body);
if (stat !== Diplomatic.Status.Success) {
  console.error(`upserting message: ${Diplomatic.Status[stat]}`);
  process.exit(1);
}
```

5. Start the host by running `bunx diplomatic-host`

6. In another terminal, run `DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run write.ts "hello world"`

To read the status, create `read.ts` with the code from the Read Demo walkthrough and run `DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run read.ts`.

### Code Walkthrough

```ts
import * as Diplomatic from "@interncom/diplomatic-cli";
```

Import DIPLOMATIC.


```ts
const seed = Diplomatic.loadSeedOrPanic("DIP_SEED");
const host = Diplomatic.loadHostOrPanic("DIP_HOST");
const client = await Diplomatic.initCLIOrPanic({ seed, host });
```

Load the cryptographic seed and host URL from environment variables.

```ts
const text = process.argv[2];
if (!text) {
  console.error(`usage: bun run write.ts <MESSAGE>`);
  process.exit(1);
}
```

Load the message to record.

```ts
const body = Diplomatic.msgpack.encode(text);
```

Encode the message as binary, using [msgpack](https://msgpack.org/).

```ts
const stat = await client.upsertSingletonSync("status", body);
if (stat !== Diplomatic.Status.Success) {
  console.error(`upserting message: ${Diplomatic.Status[stat]}`);
  process.exit(1);
}
```

Write the message to host.

## Read

Now it's time to read the status message back from the host.

### Steps

1. Create `read.ts` with the code below. We'll explain this line-by-line in the next section.

```ts
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
```

2. `DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run status/cli/read.ts`

You should see the text "hellow world", which we wrote [previously](#steps).

### Code Walkthrough

```ts
import * as Diplomatic from "@interncom/diplomatic-cli";
const { Status } = Diplomatic;
```

Import DIPLOMATIC.

```ts
function panic(msg: string) {
  console.error(msg);
  process.exit(1);
}
```

Make a helper function to exit if there's a problem.

```ts
const seed = Diplomatic.loadSeedOrPanic("DIP_SEED");
const host = Diplomatic.loadHostOrPanic("DIP_HOST");
const client = await Diplomatic.initCLIOrPanic({ seed, host });
```

Load the cryptographic seed and host URL from environment variables.

```ts
const [peekItems, statPeek] = await client.peek(0);
if (statPeek !== Status.Success) panic(`Failed to peek: ${statPeek}`);
if (peekItems.length < 1) panic(`No result`);
```

Fetch all headers (`peekItems`) from the host, starting from 0. The headers contain metadata about each status message update.

```ts
let peekItem = peekItems[0];
for (const item of peekItems) {
  if (item.seq > peekItem.seq) peekItem = item;
}
```

Find the latest encrypted message header (highest sequence number).

```ts
const [pullItems, statPull] = await client.pull([peekItem.seq]);
if (statPull !== Status.Success) panic(`Failed to pull: ${statPull}`);
if (pullItems.length < 1) panic(`No result`);
```

Pull the encrypted message body corresponding to that latest header.

```ts
const [bag, statBag] = await client.open(peekItem, pullItems[0]);
if (statBag !== Status.Success) panic(`Opening bag: ${statBag}`);
}
```

Decrypt and combine the message header and body, forming a "bag".

```ts
const body = bag?.bod;
if (body) {
  const text = Diplomatic.msgpack.decode(body);
  console.log(text);
}
```

Decode the status message text and display it.
