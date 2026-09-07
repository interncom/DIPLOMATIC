// Process-wide `[dip]` timings. Off by default.
// Enable with `{ verbose: true }` on openEntDB / openDiplomaticClient / useClient.

let on = false;

/** Turn `[dip]` timings on or off. */
export function setVerbose(v: boolean) {
  on = v === true;
}

/** Timed `[dip]` line when verbose. */
export function dipLog(msg: string, extra?: object) {
  if (!on) return;
  const t = Math.round(performance.now());
  if (extra !== undefined) {
    console.warn(`[dip ${t}ms] ${msg}`, extra);
  } else {
    console.warn(`[dip ${t}ms] ${msg}`);
  }
}
