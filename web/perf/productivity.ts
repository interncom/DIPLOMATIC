// Productivity-app dataset: ~42k msgs / ~6.5k ents (~7 msgs/ent).
// Todo payload: var-string text, var-int done, var-string note (empty = none).
// That payload is the raw body of an ent frame. typ "todo" is on the msg head.

import { Decoder, Encoder } from "../src/shared/codec";
import { makeEID } from "../src/shared/codecs/eid";
import { encodeEnt, entCodec } from "../src/shared/codecs/ent";
import { Status } from "../src/shared/consts";
import type { EntityID, ICrypto, IMessage } from "../src/shared/types";
import type { ValStat } from "../src/shared/valstat";

/** Matches a real productivity dump (~42k msgs → ~6.5k entities). */
export const PROD_NUM_ENTS = 6500;
export const PROD_NUM_MSGS = 42_000;
/** Fixed PRNG seed ("PERF" ascii). */
export const PROD_SEED = 0x50455246;
export const PROD_DATASET_VERSION = 2;

/** ~50 actions/day (docs/perf/cases.md productivity model). */
const MS_PER_ACTION = Math.floor((24 * 60 * 60 * 1000) / 50);
const T0_MS = Date.UTC(2023, 0, 1);

const TODO_TEXTS = [
  "Get groceries",
  "Reply to email",
  "Schedule dentist",
  "Pay rent",
  "Review PR",
  "Buy birthday gift",
  "Call mom",
  "Water plants",
  "Update resume",
  "Book flights",
  "Clean kitchen",
  "File taxes",
  "Walk dog",
  "Read chapter",
  "Stretch",
  "Backup laptop",
  "Plan dinner",
  "Fix bike",
  "Write notes",
  "Ship package",
];

const NOTE_SNIPS = [
  "urgent",
  "when free",
  "blocked on Alice",
  "low priority",
  "due Friday",
  "follow up",
  "waiting on reply",
];

export type ProdMsgRec = {
  /** Packed EntityID bytes. */
  e: Uint8Array;
  off: number;
  ctr: number;
  /** Ent frame whose body is the todo payload. */
  b: Uint8Array;
};

export type ProdDatasetFile = {
  v: number;
  seed: number;
  ents: number;
  msgs: number;
  recs: ProdMsgRec[];
};

/** mulberry32 — deterministic, compact PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randBytes(rng: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (rng() * 256) | 0;
  }
  return out;
}

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[(rng() * xs.length) | 0];
}

/** How many total msgs each entity gets (insert + updates). Sums to numMsgs. */
export function msgsPerEntity(
  numEnts: number,
  numMsgs: number,
): Uint16Array {
  if (numMsgs < numEnts) {
    throw new Error(`numMsgs (${numMsgs}) < numEnts (${numEnts})`);
  }
  const per = new Uint16Array(numEnts);
  // Each entity gets ≥1 (the insert).
  const updates = numMsgs - numEnts;
  const base = Math.floor(updates / numEnts);
  let rem = updates % numEnts;
  for (let i = 0; i < numEnts; i++) {
    const extra = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
    per[i] = 1 + extra;
  }
  return per;
}

// Throws unless the codec write succeeded.
function mustStatus(st: Status, what: string): void {
  if (st !== Status.Success) throw new Error(`${what} ${st}`);
}

// Returns the value, or throws with `what` when the status is not success.
function take<T>(pair: ValStat<T>, what: string): T {
  const [v, st] = pair;
  if (st !== Status.Success) throw new Error(`${what} ${st}`);
  return v;
}

// Packs one todo's text, done flag, and optional note.
function encodeTodoPayload(
  text: string,
  done: boolean,
  note: string | undefined,
): Uint8Array {
  const enc = new Encoder();
  mustStatus(enc.writeVarString(text), "text");
  mustStatus(enc.writeVarInt(done ? 1 : 0), "done");
  mustStatus(enc.writeVarString(note ?? ""), "note");
  return enc.result();
}

// Wraps a todo payload as an ent message body.
function encodeTodoBody(
  text: string,
  done: boolean,
  note: string | undefined,
): Uint8Array {
  return take(
    encodeEnt({ body: encodeTodoPayload(text, done, note) }),
    "encodeEnt",
  );
}

// True when the ent frame's todo payload has a non-empty note.
function todoHasNote(b: Uint8Array): boolean {
  const outer = new Decoder(b);
  const [ent, st] = outer.readStruct(entCodec);
  if (st !== Status.Success) return false;
  if (ent.body === undefined) return false;
  const inner = new Decoder(ent.body);
  const [, s1] = inner.readVarString();
  if (s1 !== Status.Success) return false;
  const [, s2] = inner.readVarInt();
  if (s2 !== Status.Success) return false;
  const [note, s3] = inner.readVarString();
  if (s3 !== Status.Success) return false;
  return note.length > 0;
}

/**
 * Build the full productivity message list (chronological).
 * Deterministic for a given (seed, numEnts, numMsgs).
 */
export function generateProductivityMsgs(
  opts: {
    seed?: number;
    numEnts?: number;
    numMsgs?: number;
  } = {},
): ProdMsgRec[] {
  const seed = opts.seed ?? PROD_SEED;
  const numEnts = opts.numEnts ?? PROD_NUM_ENTS;
  const numMsgs = opts.numMsgs ?? PROD_NUM_MSGS;
  const rng = mulberry32(seed);
  const counts = msgsPerEntity(numEnts, numMsgs);

  // Pre-build entity plans: remaining updates per entity after insert.
  type Ent = {
    eid: EntityID;
    createdMs: number;
    nextCtr: number;
    left: number; // remaining msgs including the insert until spent
    text: string;
    done: boolean;
  };

  // Assign create times by interleaving inserts into the global action stream.
  // Simpler: create all entity shells first with spaced create times, then
  // emit inserts then schedule updates in a global time order.
  const ents: Ent[] = [];
  for (let i = 0; i < numEnts; i++) {
    const id = randBytes(rng, 8);
    // Spread creates across the action timeline (one create every ~numMsgs/numEnts actions).
    const createdMs = T0_MS +
      i * MS_PER_ACTION * Math.max(1, Math.floor(numMsgs / numEnts));
    const [eid, stat] = makeEID({ id, ts: new Date(createdMs) });
    if (stat !== Status.Success) {
      throw new Error(`makeEID failed: ${stat}`);
    }
    ents.push({
      eid,
      createdMs,
      nextCtr: 0,
      left: counts[i],
      text: `${pick(rng, TODO_TEXTS)} #${i}`,
      done: false,
    });
  }

  // Emit in chronological order: for each global action slot, either insert a
  // not-yet-created entity or update a random live entity that still has msgs left.
  const recs: ProdMsgRec[] = [];
  let nextCreate = 0;
  const live: number[] = []; // indices into ents with remaining updates (left > 0 after insert counted)

  let t = T0_MS;
  while (recs.length < numMsgs) {
    // Prefer pending creates when their create time is due, else update.
    const canCreate = nextCreate < numEnts;
    const canUpdate = live.length > 0;
    let doCreate = false;
    if (canCreate && canUpdate) {
      // Bias: if create is "due" relative to t, create; else update.
      doCreate = ents[nextCreate].createdMs <= t || rng() < 0.35;
    } else if (canCreate) {
      doCreate = true;
    } else if (!canUpdate) {
      throw new Error("stuck: no create or update");
    }

    if (doCreate) {
      const e = ents[nextCreate];
      t = Math.max(t, e.createdMs);
      const note = rng() < 0.25 ? pick(rng, NOTE_SNIPS) : undefined;
      const b = encodeTodoBody(e.text, e.done, note);
      recs.push({ e: e.eid, off: 0, ctr: 0, b });
      e.nextCtr = 1;
      e.left -= 1;
      if (e.left > 0) live.push(nextCreate);
      nextCreate += 1;
    } else {
      const li = (rng() * live.length) | 0;
      const ei = live[li];
      const e = ents[ei];
      t += MS_PER_ACTION;
      // ~40% of updates flip done; sometimes edit text; sometimes set note.
      if (rng() < 0.4) e.done = !e.done;
      if (rng() < 0.15) {
        e.text = `${pick(rng, TODO_TEXTS)} #${ei}`;
      }
      const note = rng() < 0.3 ? pick(rng, NOTE_SNIPS) : undefined;
      const b = encodeTodoBody(e.text, e.done, note);
      const off = t - e.createdMs;
      recs.push({ e: e.eid, off, ctr: e.nextCtr, b });
      e.nextCtr += 1;
      e.left -= 1;
      if (e.left <= 0) {
        live[li] = live[live.length - 1];
        live.pop();
      }
    }
    t += MS_PER_ACTION;
  }

  if (recs.length !== numMsgs) {
    throw new Error(`expected ${numMsgs} recs, got ${recs.length}`);
  }
  return recs;
}

// Packs the dataset: version, seed, counts, then each rec.
export function packDataset(file: ProdDatasetFile): Uint8Array {
  const enc = new Encoder();
  mustStatus(enc.writeVarInt(file.v), "v");
  mustStatus(enc.writeVarInt(file.seed), "seed");
  mustStatus(enc.writeVarInt(file.ents), "ents");
  mustStatus(enc.writeVarInt(file.msgs), "msgs");
  mustStatus(enc.writeVarInt(file.recs.length), "n");
  for (const r of file.recs) {
    mustStatus(enc.writeVarBytes(r.e), "e");
    mustStatus(enc.writeVarInt(r.off), "off");
    mustStatus(enc.writeVarInt(r.ctr), "ctr");
    mustStatus(enc.writeVarBytes(r.b), "b");
  }
  return enc.result();
}

// Reads a dataset packed by packDataset. Rejects other versions.
export function unpackDataset(bytes: Uint8Array): ProdDatasetFile {
  const dec = new Decoder(bytes);
  const v = take(dec.readVarInt(), "v");
  if (v !== PROD_DATASET_VERSION) {
    throw new Error(`dataset: unsupported version ${v}`);
  }
  const seed = take(dec.readVarInt(), "seed");
  const ents = take(dec.readVarInt(), "ents");
  const msgs = take(dec.readVarInt(), "msgs");
  const n = take(dec.readVarInt(), "n");
  const recs: ProdMsgRec[] = [];
  for (let i = 0; i < n; i++) {
    const e = take(dec.readVarBytes(), "e");
    const off = take(dec.readVarInt(), "off");
    const ctr = take(dec.readVarInt(), "ctr");
    const b = take(dec.readVarBytes(), "b");
    recs.push({ e, off, ctr, b });
  }
  if (!dec.done()) throw new Error("dataset: trailing bytes");
  return { v, seed, ents, msgs, recs };
}

/** Turn dataset records into IMessage values (with body hashes). */
export async function recsToMessages(
  recs: ProdMsgRec[],
  crypto: ICrypto,
): Promise<IMessage[]> {
  const out: IMessage[] = [];
  for (const r of recs) {
    const len = r.b.length;
    const hsh = await crypto.blake3(r.b);
    out.push({
      eid: r.e as EntityID,
      off: r.off,
      ctr: r.ctr,
      typ: "todo",
      len,
      hsh,
      bod: r.b,
    });
  }
  return out;
}

export function datasetStats(recs: ProdMsgRec[]): {
  msgs: number;
  ents: number;
  avgMsgsPerEnt: number;
  bodyBytes: number;
  meanBody: number;
  withNote: number;
} {
  const eids = new Set<string>();
  let bodyBytes = 0;
  let withNote = 0;
  for (const r of recs) {
    eids.add(Array.from(r.e).join(","));
    bodyBytes += r.b.length;
    if (todoHasNote(r.b)) withNote += 1;
  }
  const msgs = recs.length;
  const ents = eids.size;
  return {
    msgs,
    ents,
    avgMsgsPerEnt: msgs / ents,
    bodyBytes,
    meanBody: bodyBytes / msgs,
    withNote,
  };
}
