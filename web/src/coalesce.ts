/**
 * Coalesce concurrent async work into a single in-flight drain, with one
 * trailing pass when more work is requested while a pass is running.
 *
 * Policy:
 * - At most one `work()` runs at a time (no overlapping executions).
 * - Concurrent `run()` callers share one Promise and get the same result.
 * - If `run()` is called during an in-flight pass, `again` is set so that
 *   after the current pass finishes we run **one** more pass (trailing edge).
 *   Further calls during that trailing pass can request yet another, etc.
 * - N stampeding callers during a pass → 1 current pass + ≤1 trailing pass
 *   per generation, not N serial full runs.
 * - Errors from `work()` reject the shared Promise; the runner unlocks so a
 *   later `run()` can start fresh. A trailing request that only set `again`
 *   before the failure is not auto-retried unless a new `run()` arrives.
 */
export class CoalesceTail<T> {
  private inflight: Promise<T> | null = null;
  private again = false;

  run(work: () => Promise<T>): Promise<T> {
    // Always mark demand. If already draining, the loop will do a trailing pass.
    this.again = true;
    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.drain(work);
    return this.inflight;
  }

  /** Wait for any in-flight drain to finish (does not request a new pass). */
  async flush(): Promise<void> {
    if (!this.inflight) {
      return;
    }
    try {
      await this.inflight;
    } catch {
      // Caller only cares that work is no longer running.
    }
  }

  private async drain(work: () => Promise<T>): Promise<T> {
    try {
      // again is true on entry (set by run). Clear before the first pass so
      // concurrent run() during work() can re-raise it for a trailing pass.
      this.again = false;
      let last = await work();
      while (this.again) {
        this.again = false;
        last = await work();
      }
      return last;
    } finally {
      // Single-threaded: nothing can interleave between the while exit and
      // this assignment, so a concurrent run() either joined inflight (and
      // set again for another loop iteration) or arrives after unlock and
      // starts a new drain.
      this.inflight = null;
    }
  }
}

/** Default quiet period before a scheduled sync after local writes. */
export const defaultSyncDebounceMs = 100;

/**
 * Debounce async work: each `schedule()` resets a timer; when the quiet period
 * elapses, `work` runs via {@link CoalesceTail} so stampeding fires do not
 * overlap (trailing pass if more demand arrives mid-run).
 *
 * - `delayMs <= 0`: run on the next microtask path immediately (no timer).
 * - `flush()`: cancel the timer, start work if a run was pending, await drain.
 * - `cancel()`: drop the pending timer without running (in-flight continues).
 */
export class Debounced<T = void> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly work: () => Promise<T>;
  private readonly tail = new CoalesceTail<T>();

  constructor(delayMs: number, work: () => Promise<T>) {
    this.delayMs = delayMs < 0 ? 0 : delayMs;
    this.work = work;
  }

  /** Request a run after the debounce quiet period (resets the timer). */
  schedule(): void {
    if (this.delayMs <= 0) {
      void this.fire();
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, this.delayMs);
  }

  /**
   * Run any pending debounced work now and wait until the drain finishes.
   * No-op if nothing is pending or in flight.
   */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      void this.fire();
    }
    await this.tail.flush();
  }

  /** Drop a pending timer without starting work. In-flight work is untouched. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private fire(): Promise<T> {
    return this.tail.run(this.work);
  }
}
