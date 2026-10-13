// Musec collection rejects paste, arrows, and autorepeat.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  applyTtyChunk,
  emptyMix,
  MIN_KEYS,
  type Mix,
  takeMusec,
} from "../../tools/keys/musec.ts";

const PASTE_BEG = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];

function key(c: number): Uint8Array {
  return Uint8Array.of(c);
}

function feed(st: Mix, bytes: Uint8Array, now: number): string {
  return applyTtyChunk(st, bytes, now);
}

// Sixteen keys with uneven human gaps. Returns the time of the last key.
function typeHuman(st: Mix, t0 = 0): number {
  const gaps = [
    80,
    120,
    200,
    90,
    300,
    70,
    150,
    400,
    60,
    180,
    90,
    250,
    110,
    160,
    500,
  ];
  let now = t0;
  const first = feed(st, key(0x61), now);
  assertEquals(first, ".");
  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i];
    if (gap === undefined) continue;
    now += gap;
    const c = 0x62 + (i % 20);
    assertEquals(feed(st, key(c), now), ".");
  }
  return now;
}

Deno.test("human keys finish and each key is stamped", () => {
  const st = emptyMix(MIN_KEYS);
  const end = typeHuman(st);
  assertEquals(feed(st, key(13), end + 50), "done");
  const raw = takeMusec(st);
  assertEquals(raw.byteLength, MIN_KEYS * 9);
  assertEquals(raw[8], 0x61);
  assertEquals(st.out.length, 0);
  raw.fill(0);
});

Deno.test("autorepeat counts one key", () => {
  const st = emptyMix(MIN_KEYS);
  assertEquals(feed(st, key(0x61), 0), ".");
  let now = 0;
  for (let i = 0; i < 30; i++) {
    now += 30;
    const r = feed(st, key(0x61), now);
    if (i === 0) assertEquals(r, " (slower)\n");
    else assertEquals(r, "");
  }
  assertEquals(feed(st, key(13), now), " (15 more)\n");
  assertEquals(takeMusec(st).byteLength, 9);
});

Deno.test("even gaps are rejected until the pace varies", () => {
  const st = emptyMix(MIN_KEYS);
  let now = 0;
  for (let i = 0; i < MIN_KEYS; i++) {
    assertEquals(feed(st, key(0x61 + i), now), ".");
    now += 80;
  }
  now -= 80;
  assertEquals(feed(st, key(13), now), " (too even)\n");
  now += 400;
  assertEquals(feed(st, key(0x7a), now), ".");
  assertEquals(feed(st, key(13), now), "done");
});

Deno.test("keys inside one second are too fast", () => {
  const st = emptyMix(MIN_KEYS);
  let now = 0;
  const gaps = [40, 90, 40, 70, 40, 40, 80, 40, 50, 40, 60, 40, 45, 40, 50];
  assertEquals(feed(st, key(0x61), now), ".");
  for (const g of gaps) {
    now += g;
    assertEquals(feed(st, key(0x62), now), ".");
  }
  assert(now < 1000);
  assertEquals(feed(st, key(13), now), " (too fast)\n");
});

Deno.test("a pasted chunk does not count", () => {
  const st = emptyMix(MIN_KEYS);
  const paste = new TextEncoder().encode("hellohellohello!");
  assertEquals(feed(st, paste, 0), " (paste ignored)\n");
  assertEquals(feed(st, paste, 100), "");
  assertEquals(takeMusec(st).byteLength, 0);
});

Deno.test("bracketed paste, including Enter, does not count", () => {
  const st = emptyMix(MIN_KEYS);
  const text = new TextEncoder().encode("hello\nhello\n");
  const buf = new Uint8Array(
    PASTE_BEG.length + text.byteLength + PASTE_END.length,
  );
  buf.set(PASTE_BEG, 0);
  buf.set(text, PASTE_BEG.length);
  buf.set(PASTE_END, PASTE_BEG.length + text.byteLength);
  assertEquals(feed(st, buf, 0), "");
  assertEquals(st.mode, "key");
  assertEquals(takeMusec(st).byteLength, 0);
});

Deno.test("arrows do not count, split or whole", () => {
  const st = emptyMix(MIN_KEYS);
  assertEquals(feed(st, new Uint8Array([0x1b, 0x5b, 0x41]), 0), "");
  assertEquals(feed(st, Uint8Array.of(0x1b), 50), "");
  assertEquals(feed(st, new Uint8Array([0x5b, 0x42]), 60), "");
  assertEquals(feed(st, key(0x61), 100), ".");
  assertEquals(takeMusec(st).byteLength, 9);
});

Deno.test("Ctrl-C aborts", () => {
  const st = emptyMix(MIN_KEYS);
  assertEquals(feed(st, Uint8Array.of(3), 0), "abort");
});
