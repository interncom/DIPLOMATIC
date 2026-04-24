# Tutorial

We'll make an app that syncs a text status message, using DIPLOMATIC.

## Host

DIPLOMATIC is explicitly *not* a peer-to-peer (P2P) system. It syncs data between clients via one or more hosts. So to begin, we must run a host.

We'll use [bun](https://bun.com/). So go install that, if you don't have it yet.

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

## Watch

Now we'll create a watch tool that displays real-time status updates using [WebSockets](https://developer.mozilla.org/es/docs/Web/API/WebSockets_API).

### Steps

1. Install [bun](https://bun.com/).
2. `bun init`
3. `bun add @interncom/diplomatic-cli`
4. Create `watch.ts` with the code below. We'll explain this line-by-line in the next section.

```ts
import * as Diplomatic from "@interncom/diplomatic-cli";
import { Decoder } from "@interncom/diplomatic-cli";
import { IBagNotifItem, notifItemCodec } from "@interncom/diplomatic-cli";
import { IBagPullItem } from "@interncom/diplomatic-cli";
const { Status } = Diplomatic;

function panic(msg: string) {
  console.error(msg);
  process.exit(1);
}

const seed = Diplomatic.loadSeedOrPanic("DIP_SEED");
const host = Diplomatic.loadHostOrPanic("DIP_HOST");
const client = await Diplomatic.initCLIOrPanic({ seed, host });

async function handleNotif(item: IBagNotifItem): Promise<Status> {
  if (!item.bodyCph) return Status.MissingBody;
  const pullItem: IBagPullItem = { bodyCph: item.bodyCph, seq: item.seq };

  const [bag, statBag] = await client.open(item, pullItem);
  if (statBag !== Status.Success) {
    console.error(`Failed to open bag: ${Status[statBag]}`);
    return statBag;
  }

  const body = bag?.bod;
  if (!body) {
    return Status.MissingBody;
  }

  const text = Diplomatic.msgpack.decode(body);
  console.log(text);

  return Status.Success;
}

async function handleWebsocketMessage(bytes: Uint8Array) {
  const dec = new Decoder(bytes);
  const [notifItems, stat] = dec.readStructs(notifItemCodec);
  if (stat !== Status.Success) {
    console.error(`Failed to decode notification: ${Status[stat]}`);
    return stat;
  }

  for (const item of notifItems) {
    const statNotif = await handleNotif(item);
    if (statNotif !== Status.Success) {
      console.error(`Failed to handle notification: ${Status[statNotif]}`);
      return stat;
    }
  }

  return Status.Success;
}

const statListen = await client.listen(handleWebsocketMessage);

if (statListen !== Status.Success) {
  panic(`Failed to listen: ${Status[statListen]}`);
}

// Keep the process running
process.stdin.resume();
```

5. Start the host by running `DIPLOMATIC_HOST_PORT=31337 bunx diplomatic-host`

6. Open another terminal and run `DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run watch.ts`

7. Open another terminal and run `DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run write.ts "hello world"`.

8. Observe the watch terminal print the message.

### Code Walkthrough

```ts
import * as Diplomatic from "@interncom/diplomatic-cli";
import { Decoder } from "@interncom/diplomatic-cli";
import { IBagNotifItem, notifItemCodec } from "@interncom/diplomatic-cli";
import { IBagPullItem } from "@interncom/diplomatic-cli";
const { Status } = Diplomatic;
```

Import DIPLOMATIC and the necessary types/codecs.

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

Load the cryptographic seed and host URL from environment variables, then initialize a client.

```ts
async function handleNotif(item: IBagNotifItem): Promise<Status> {
  if (!item.bodyCph) return Status.MissingBody;
  const pullItem: IBagPullItem = { bodyCph: item.bodyCph, seq: item.seq };

  const [bag, statBag] = await client.open(item, pullItem);
  if (statBag !== Status.Success) {
    console.error(`Failed to open bag: ${Status[statBag]}`);
    return statBag;
  }

  const body = bag?.bod;
  if (!body) {
    return Status.MissingBody;
  }

  const text = Diplomatic.msgpack.decode(body);
  console.log(text);

  return Status.Success;
}
```

Take a notification item with inlined body, then decode and print the text contents. For small-enough messages, DIPLOMATIC inlines the body in notifications (notifs, for short). In larger messages, the notif only contains the message header.

```ts
async function handleWebsocketMessage(bytes: Uint8Array) {
  const dec = new Decoder(bytes);
  const [notifItems, stat] = dec.readStructs(notifItemCodec);
  if (stat !== Status.Success) {
    console.error(`Failed to decode notification: ${Status[stat]}`);
    return stat;
  }

  for (const item of notifItems) {
    const statNotif = await handleNotif(item);
    if (statNotif !== Status.Success) {
      console.error(`Failed to handle notification: ${Status[statNotif]}`);
      return stat;
    }
  }

  return Status.Success;
}
```

Handle incoming WebSocket messages. Each WebSocket message can contain multiple bag notifications. We send those through handleNotif, one-by-one.

```ts
const statListen = await client.listen(handleWebsocketMessage);

if (statListen !== Status.Success) {
  panic(`Failed to listen: ${Status[statListen]}`);
}

// Keep the process running
process.stdin.resume();
```

Start listening for notifs via WebSocket, and keep the process alive to continue watching.

## Web

Now we'll create a web app that displays the status message in real-time.

### Steps

1. Create a new plain app: `npm create @interncom/diplomatic@latest status-web-app`

2. When prompted, choose "Vanilla TS/HTML (Singleton)" as the app type.

3. `cd status-web-app`

4. `npm install`

5. Edit `src/main.ts` with the code below (or replace it entirely). We'll explain this line-by-line in the next section.

```ts
import { decode } from '@msgpack/msgpack'
import * as Diplomatic from '@interncom/diplomatic'

const msgType = "status";

const statusDiv = document.getElementById('status')!

export async function register(): Promise<void> {
  const stored = localStorage.getItem('status')
  if (stored) statusDiv.textContent = stored

  try {
    const seedHex = (document.getElementById('seed') as HTMLInputElement).value
    const hostURL = (document.getElementById('host') as HTMLInputElement).value

    if (!seedHex) throw new Error('Enter a valid seed (64 hex chars)')
    if (!hostURL) throw new Error('Enter a valid host URL')

    const stateMgr = new Diplomatic.SingletonStateManager(msgType)
    stateMgr.on(msgType, () => {
      if (!stateMgr.latest) return;
      const bodyStr = decode(stateMgr.latest) as string
      localStorage.setItem('status', bodyStr)
      statusDiv.textContent = bodyStr
    })

    const { setSeed } = await Diplomatic.genWebClient(stateMgr, new URL(hostURL));
    await setSeed(seedHex);
  } catch (e) {
    statusDiv.textContent = `Error: ${(e as Error).message}`
  }
}

(window as any).register = register;
```

6. Update `index.html` to include inputs for seed and host, and a button to register:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Status Demo</title>
</head>
<body>
  <h1>Status Demo</h1>
  <div>
    <label for="seed">Seed (64 hex chars):</label>
    <input type="text" id="seed" placeholder="0123456789ABCDEF..." />
  </div>
  <div>
    <label for="host">Host URL:</label>
    <input type="text" id="host" placeholder="http://localhost:31337" />
  </div>
  <button onclick="register()">Register</button>
  <div id="status">Status will appear here...</div>
  <script type="module" src="./src/main.ts"></script>
</body>
</html>
```

7. Start the host: `bunx diplomatic-host`

8. In another terminal, serve the web app: `npm run dev`

9. Open the web app in a browser, enter the seed and host URL, click Register.

10. In another terminal, write a status: `DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run write.ts "hello world"`

11. Observe the web app update with the new status message.

### Code Walkthrough

```ts
import { decode } from '@msgpack/msgpack'
import * as Diplomatic from '@interncom/diplomatic'
```

Import msgpack for decoding and DIPLOMATIC for the web client.

```ts
const msgType = "status";

const statusDiv = document.getElementById('status')!
```

Define the message type and get the DOM element to display the status.

```ts
export async function register(): Promise<void> {
  const stored = localStorage.getItem('status')
  if (stored) statusDiv.textContent = stored
```

The register function sets up the client. First, load any previously stored status from localStorage.

```ts
  try {
    const seedHex = (document.getElementById('seed') as HTMLInputElement).value
    const hostURL = (document.getElementById('host') as HTMLInputElement).value

    if (!seedHex) throw new Error('Enter a valid seed (64 hex chars)')
    if (!hostURL) throw new Error('Enter a valid host URL')
```

Get the seed and host URL from the input fields, validating they're provided.

```ts
    const stateMgr = new Diplomatic.SingletonStateManager(msgType)
    stateMgr.on(msgType, () => {
      if (!stateMgr.latest) return;
      const bodyStr = decode(stateMgr.latest) as string
      localStorage.setItem('status', bodyStr)
      statusDiv.textContent = bodyStr
    })
```

Create a state manager for the singleton "status" message. Set up an event listener that decodes the latest message, stores it in localStorage, and displays it.

```ts
    const { setSeed } = await Diplomatic.genWebClient(stateMgr, new URL(hostURL));
    await setSeed(seedHex);
  } catch (e) {
    statusDiv.textContent = `Error: ${(e as Error).message}`
  }
}
```

Generate a web client connected to the host, then set the cryptographic seed. If anything fails, display the error.

```ts
(window as any).register = register;
```

Expose the register function globally so it can be called from the HTML onclick handler.
