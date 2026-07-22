/** Sync / import progress phase ticks.
 *
 * Exposed only via `IDiplomaticClientXferState.progress` on `client.xferState`
 * (get + listen / `useClientXferState`). There is no separate progress channel. */

export type SyncPhase =
  | "peek"
  | "pull"
  | "open"
  | "exec"
  | "push"
  | "import"
  | "idle";

export interface SyncProgressEvent {
  phase: SyncPhase;
  /** Host label when the work is host-scoped. */
  host?: string;
  /** Items completed in this phase so far (when known). */
  done?: number;
  /** Total items for this phase (when known up front). */
  total?: number;
  /** Bytes completed (optional; push/pull soft budgets). */
  bytesDone?: number;
  /** Bytes total for the phase snapshot (optional). */
  bytesTotal?: number;
}

/** Resting progress when no sync/import is in flight. */
export const idleProgress: SyncProgressEvent = { phase: "idle" };

export type ProgressFn = (ev: SyncProgressEvent) => void;

/* Default peek progress stride: emit every N heads (plus first and last). */
export const defaultPeekProgressEvery = 50;

/** Emit when `done` is 1, every `every` heads, and on the final head. */
export function shouldEmitItemProgress(
  done: number,
  total: number,
  every: number,
): boolean {
  if (done <= 0 || total <= 0) {
    return false;
  }
  if (done === 1 || done === total) {
    return true;
  }
  return done % every === 0;
}
