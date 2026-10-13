// Keystroke musec for Enclave.fromRandom. Paste and autorepeat do not count.

export const MIN_KEYS = 16;
// Autorepeat and a pasted burst arrive closer together than this.
const MIN_GAP_MS = 40;
// A span shorter than this is too fast for sixteen typed keys.
const MIN_SPAN_MS = 1000;
// Held-key repeat barely jitters. A person varies the gaps by more than this.
const MIN_SPREAD_MS = 30;

const PASTE_BEG: readonly number[] = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
const PASTE_END: readonly number[] = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];

export type Mix = {
  min: number;
  out: number[];
  at: number[];
  mode: "key" | "esc" | "paste";
  esc: number[];
  pend: number;
  noted: boolean;
  rushed: boolean;
  heard: number | undefined;
};

// Starts an empty keystroke mix that closes only after `min` accepted keys.
export function emptyMix(min: number): Mix {
  return {
    min,
    out: [],
    at: [],
    mode: "key",
    esc: [],
    pend: 0,
    noted: false,
    rushed: false,
    heard: undefined,
  };
}

// Copies the collected keystroke bytes out of `st` and then zeroes the mix.
export function takeMusec(st: Mix): Uint8Array {
  const out = new Uint8Array(st.out);
  wipeMix(st);
  return out;
}

// Applies one terminal read, taken at `now` milliseconds, to the mix.
// Returns "" when the chunk was absorbed, "done" when Enter closed a usable
// mix, "abort" on Ctrl-C, or a short note to print on the terminal.
export function applyTtyChunk(
  st: Mix,
  bytes: Uint8Array,
  now: number,
): string {
  if (st.mode === "key" && !bytes.includes(0x1b) && !bytes.includes(3)) {
    return countPlainChunk(st, bytes, now);
  }
  return consumeControlChunk(st, bytes, now);
}

// Zeroes the key bytes, timings, and partial escape sequence stored in `st`.
function wipeMix(st: Mix) {
  st.out.fill(0);
  st.at.fill(0);
  st.esc.fill(0);
  st.out.length = 0;
  st.at.length = 0;
  st.esc = [];
  st.pend = 0;
}

// Appends an 8-byte big-endian nanosecond timestamp for `ms`, then key `c`.
function appendStampedKey(out: number[], ms: number, c: number) {
  const now = BigInt(Math.floor(ms * 1e6));
  for (let s = 56n; s >= 0n; s -= 8n) {
    out.push(Number((now >> s) & 0xffn));
  }
  out.push(c);
}

// Measures the spread of gaps between accepted keys, in milliseconds.
// The spread is the longest gap minus the shortest. An even repeat returns 0.
function gapSpreadMs(at: number[]): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (let i = 1; i < at.length; i++) {
    const a = at[i - 1];
    const b = at[i];
    if (a === undefined || b === undefined) continue;
    const g = b - a;
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  if (hi < lo) return 0;
  return hi - lo;
}

// Records `c` at `now` when it is at least MIN_GAP_MS after the previous key.
// Returns "." when the key is recorded, " (slower)\n" the first time a key
// arrives too soon, and "" when further rushed keys are ignored.
function recordKeystroke(st: Mix, c: number, now: number): string {
  const prev = st.heard;
  st.heard = now;
  if (prev !== undefined && now - prev < MIN_GAP_MS) {
    if (!st.rushed) {
      st.rushed = true;
      return " (slower)\n";
    }
    return "";
  }
  st.at.push(now);
  appendStampedKey(st.out, now, c);
  return ".";
}

// Checks whether Enter can close the mix.
// Returns "done" when at least `min` keys span MIN_SPAN_MS and their gaps
// vary by MIN_SPREAD_MS. Otherwise returns a note that the mix is still
// short, too fast, or too even.
function checkClose(st: Mix): string {
  const n = st.at.length;
  if (n < st.min) return ` (${st.min - n} more)\n`;
  const t0 = st.at[0];
  const t1 = st.at[n - 1];
  if (t0 === undefined || t1 === undefined) return " (too fast)\n";
  if (t1 - t0 < MIN_SPAN_MS) return " (too fast)\n";
  if (gapSpreadMs(st.at) < MIN_SPREAD_MS) return " (too even)\n";
  return "done";
}

// Returns true when `a` and `b` have the same length and the same bytes.
function equalBytes(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Reports whether `esc` has the final byte of an escape sequence.
// ESC plus one byte is complete. CSI (ESC [) stays open until a final byte
// in the range 0x40–0x7e.
function escapeFinished(esc: number[]): boolean {
  if (esc.length < 2) return false;
  if (esc[1] !== 0x5b) return true;
  if (esc.length < 3) return false;
  const last = esc[esc.length - 1];
  return last !== undefined && last >= 0x40 && last <= 0x7e;
}

// Matches `c` against the next byte of the bracketed-paste closer.
// Returns true when `c` completes that closer. A mismatch restarts the match.
function matchPasteEnd(st: Mix, c: number): boolean {
  const want = PASTE_END[st.pend];
  if (c === want) {
    st.pend++;
    if (st.pend === PASTE_END.length) {
      st.pend = 0;
      return true;
    }
    return false;
  }
  st.pend = c === PASTE_END[0] ? 1 : 0;
  return false;
}

// Counts keystrokes in a chunk that has no ESC byte and no Ctrl-C.
// One printable ASCII byte is a keystroke. A longer body is an unbracketed
// paste and is ignored. A trailing Enter checks whether the mix can close.
function countPlainChunk(st: Mix, bytes: Uint8Array, now: number): string {
  let n = bytes.byteLength;
  let enter = false;
  while (n > 0) {
    const c = bytes[n - 1];
    if (c !== 13 && c !== 10) break;
    enter = true;
    n--;
  }
  const body = bytes.subarray(0, n);
  let note = "";
  if (body.byteLength === 1) {
    const c = body[0];
    if (c !== undefined && c >= 0x20 && c <= 0x7e) {
      note = recordKeystroke(st, c, now);
    }
  } else if (body.byteLength > 1) {
    if (!st.noted) {
      st.noted = true;
      note = " (paste ignored)\n";
    }
  }
  if (!enter) return note;
  const fin = checkClose(st);
  if (fin === "done") return "done";
  return note + fin;
}

// Consumes a chunk that contains an escape, a bracketed paste, or Ctrl-C.
// Escape sequences and paste bytes are dropped. Ctrl-C returns "abort".
// A printable byte outside those sequences still counts as a keystroke.
function consumeControlChunk(st: Mix, bytes: Uint8Array, now: number): string {
  let note = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const c = bytes[i];
    if (c === undefined) continue;
    if (c === 3) return "abort";
    if (st.mode === "paste") {
      if (matchPasteEnd(st, c)) st.mode = "key";
      continue;
    }
    if (st.mode === "esc") {
      st.esc.push(c);
      if (st.esc.length > 32) {
        st.esc.fill(0);
        st.esc = [];
        st.mode = "key";
        continue;
      }
      if (!escapeFinished(st.esc)) continue;
      st.mode = equalBytes(st.esc, PASTE_BEG) ? "paste" : "key";
      st.esc.fill(0);
      st.esc = [];
      continue;
    }
    if (c === 0x1b) {
      st.mode = "esc";
      st.esc = [c];
      continue;
    }
    if (c === 13 || c === 10) {
      const fin = checkClose(st);
      if (fin === "done") return "done";
      return note + fin;
    }
    if (c < 0x20 || c > 0x7e) continue;
    const dot = recordKeystroke(st, c, now);
    if (dot !== "") note = dot;
  }
  return note;
}
