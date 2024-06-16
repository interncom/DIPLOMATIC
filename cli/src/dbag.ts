// Client.

import { generateSeed } from "./auth.ts";
import { deriveEncryptionKey, serialize } from "./client.ts";
import { port, regToken } from "./consts.ts";
import type { IOp, IRegistrationRequest, ISyncRequest } from "./types.ts";
import { encode, decode } from "https://deno.land/x/msgpack@v1.4/mod.ts";

const op: IOp<"test"> = {
  ts: new Date().toISOString(),
  type: "test",
  verb: 1,
  ver: 0,
  body: {
    x: 22,
  },
};

interface IState {
  pkey: Uint8Array;
  userID?: string;
  ops?: IOp<"test">[];
  lastSyncAt?: string;
}

const args = Deno.args;
if (args.length < 1) {
  console.error("USAGE: deno run --allow-net --allow-read --allow-write dbag.ts STATE");
  Deno.exit(1);
}
const stateFile = args[0];

function initState(): IState {
  const seed = generateSeed();
  const pkey = deriveEncryptionKey(seed);
  return {
    pkey,
    userID: undefined,
    ops: [],
  }
}

async function saveState(state: IState): Promise<void> {
  console.log(`Writing to ${stateFile}`);
  const ser = serialize(state);
  await Deno.writeFile(stateFile, ser, { mode: 0o600 });
}

async function loadState(): Promise<IState | null> {
  try {
    const ser = await Deno.readFile(stateFile);
    // TODO: dynamically check type.
    const state = await decode(ser) as IState;
    console.log("Loaded state", state.ops?.length)
    return state;
  } catch {
    console.error("Error loading state")
    return null
  }
}

const host = `http://localhost:${port}`
const state: IState = (await loadState()) ?? initState();

if (!state.userID) {
  // Register.
  console.log("Registering...")
  const payload: IRegistrationRequest = { token: regToken };
  const ser = encode(payload);
  const resp = await fetch(`${host}/users`, { method: "POST", body: ser });
  const x = await resp.json();
  if (!x.userID) {
    console.error("Failed to register");
    Deno.exit(1)
  }
  state.userID = x.userID;
  await saveState(state);
}

function apply<T extends "test">(state: IState, op: IOp<T>) {
  state.ops ??= [];
  state.ops.push(op);
}

const ops = [op];
const encOps: Uint8Array[] = [];
for (const op of ops) {
  const ser = serialize(op);
  const enc = encrypt(ser, state.pkey);
  encOps.push(enc);
}
const payload: ISyncRequest = {
  ops: encOps,
  begin: state.lastSyncAt ?? new Date(0).toISOString(),
};
const ser = serialize(payload);
try {
  const resp = await fetch(`${host}/sync`, {
    method: "POST",
    body: ser,
  });
  const ret = await resp.json();
  state.lastSyncAt = ret.syncedAt;

  for (const op of ret.ops) {
    apply(state, op);
  }

  await saveState(state);
} catch (err) {
  console.error("Oh no.", err)
}
