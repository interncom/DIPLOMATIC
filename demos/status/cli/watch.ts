// Prints status messages as the host sends them. Nothing is stored on disk.

import {
  Decoder,
  initCLIOrPanic,
  loadEnclaveOrPanic,
  loadHostOrPanic,
  notifItemCodec,
  Status,
} from "../../../cli/src/index.ts";
import type { IBagNotifItem } from "../../../cli/src/index.ts";
import type { IBagPullItem } from "../../../cli/src/index.ts";

function panic(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const enclave = loadEnclaveOrPanic("DIP_SEED");
const host = loadHostOrPanic("DIP_HOST");
const client = await initCLIOrPanic({ enclave, host });

// handleNotif opens one notification and prints its body.
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

  const text = new TextDecoder().decode(body);
  console.log(text);

  return Status.Success;
}

// handleWebsocketMessage decodes a notification frame and prints each item.
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
