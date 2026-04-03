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
