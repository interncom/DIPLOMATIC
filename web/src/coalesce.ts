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
