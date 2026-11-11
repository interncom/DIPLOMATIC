// Watches status ents and keeps them in the disk store.

import { latestStatus, openStatus } from "./open.ts";

const { client, state, ents } = await openStatus();
let ready = false;

// show prints the newest stored status ent.
async function show() {
  const text = await latestStatus(ents);
  if (text !== undefined) console.log(text);
}

state.on("status", () => {
  if (!ready) return;
  void show();
});
await client.connect(true, true);
ready = true;
await show();
process.stdin.resume();
