import * as Diplomatic from "@interncom/diplomatic-cli";
import { Decoder, IBagNotifItem, notifItemCodec, IBagPullItem } from "@interncom/diplomatic-cli";
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
