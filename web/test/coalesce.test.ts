import { describe, expect, test, vi } from "vitest";
import { CoalesceTail, Debounced } from "../src/coalesce";
import { Status } from "../src/shared/consts";
import { SyncClient } from "../src/client";
import { MemoryStore } from "../src/stores/memory/store";
import type { IProtoHost, IStateManager } from "../src/shared/types";
import { DiplomaticLPCServer, LPCTransport } from "../src/shared/lpc/server";
import memStorage from "../src/shared/storage/memory";
import libsodiumCrypto from "../src/crypto";
import { CallbackNotifier } from "../src/shared/lpc/pusher";
import { MockClock } from "../src/shared/clock";

function defer<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("CoalesceTail", () => {
  test("runs work once for a single caller", async () => {
    const tail = new CoalesceTail<number>();
    let n = 0;
    const result = await tail.run(async () => {
      n++;
      return 42;
    });
    expect(result).toBe(42);
    expect(n).toBe(1);
  });

  test("never overlaps work; concurrent callers share one drain", async () => {
    const tail = new CoalesceTail<string>();
    let depth = 0;
    let maxDepth = 0;
    let passes = 0;
    const gate = defer();

    const work = async () => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      passes++;
      // First pass waits so later run() can join mid-flight.
      if (passes === 1) {
        await gate.promise;
      }
      depth--;
      return `pass-${passes}`;
    };

    const p1 = tail.run(work);
    const p2 = tail.run(work);
    const p3 = tail.run(work);

    gate.resolve();
    const results = await Promise.all([p1, p2, p3]);

    // One in-flight pass + one trailing pass (again was set by p2/p3).
    expect(passes).toBe(2);
    expect(maxDepth).toBe(1);
    // All waiters get the final trailing result.
    expect(results).toEqual(["pass-2", "pass-2", "pass-2"]);
  });

  test("trailing pass runs when run() is called during work", async () => {
    const tail = new CoalesceTail<number>();
    let passes = 0;
    const mid = defer();
    const resume = defer();

    const p1 = tail.run(async () => {
      passes++;
      if (passes === 1) {
        mid.resolve();
        await resume.promise;
      }
      return passes;
    });

    await mid.promise;
    // Request sync while first pass is held open → trailing edge.
    const p2 = tail.run(async () => {
      passes++;
      return passes;
    });
    resume.resolve();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(passes).toBe(2);
    expect(r1).toBe(2);
    expect(r2).toBe(2);
  });

  test("sequential run() after drain completes starts a fresh pass", async () => {
    const tail = new CoalesceTail<number>();
    let passes = 0;
    const work = async () => {
      passes++;
      return passes;
    };

    expect(await tail.run(work)).toBe(1);
    expect(await tail.run(work)).toBe(2);
    expect(passes).toBe(2);
  });

  test("propagates errors and unlocks for a later run", async () => {
    const tail = new CoalesceTail<number>();
    let passes = 0;

    await expect(
      tail.run(async () => {
        passes++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(passes).toBe(1);

    const ok = await tail.run(async () => {
      passes++;
      return 7;
    });
    expect(ok).toBe(7);
    expect(passes).toBe(2);
  });

  test("stampede of N callers during one pass yields two passes not N", async () => {
    const tail = new CoalesceTail<number>();
    let passes = 0;
    const gate = defer();

    const work = async () => {
      passes++;
      if (passes === 1) await gate.promise;
      return passes;
    };

    const first = tail.run(work);
    const rest = Array.from({ length: 20 }, () => tail.run(work));
    gate.resolve();
    const results = await Promise.all([first, ...rest]);

    expect(passes).toBe(2);
    expect(results.every((r) => r === 2)).toBe(true);
  });
});

describe("Debounced", () => {
  test("delay 0 runs work without waiting", async () => {
    let n = 0;
    const d = new Debounced(0, async () => {
      n++;
    });
    d.schedule();
    d.schedule();
    await d.flush();
    // CoalesceTail may run 1–2 passes for two immediate schedules.
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
  });

  test("positive delay coalesces rapid schedule() into one fire", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const d = new Debounced(100, async () => {
        n++;
      });
      d.schedule();
      d.schedule();
      d.schedule();
      expect(n).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      await d.flush();
      expect(n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("flush runs pending work immediately", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const d = new Debounced(5000, async () => {
        n++;
      });
      d.schedule();
      expect(n).toBe(0);
      await d.flush();
      expect(n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancel drops pending timer without running", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const d = new Debounced(100, async () => {
        n++;
      });
      d.schedule();
      d.cancel();
      await vi.advanceTimersByTimeAsync(200);
      await d.flush();
      expect(n).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SyncClient.sync coalesce+trailing", () => {
  test("overlapping sync() share one doSync promise and final Status", async () => {
    const store = new MemoryStore<IProtoHost>(libsodiumCrypto);
    const state: IStateManager = {
      async apply(msgs) {
        return msgs.map(() => Status.Success);
      },
      async clear() {
        return Status.Success;
      },
      notify() {},
      async refresh() {},
      on() {},
      off() {},
    };
    const lpcHost = new DiplomaticLPCServer(
      memStorage,
      libsodiumCrypto,
      new CallbackNotifier(),
      new MockClock(new Date(0)),
    );
    const client = new SyncClient(
      new MockClock(new Date(0)),
      state,
      store,
      () => new LPCTransport(lpcHost),
      libsodiumCrypto,
    );

    // Gate seed.load so we can stampede sync() mid-run.
    let loads = 0;
    const entered = defer();
    const gate = defer();
    const origLoad = store.seed.load.bind(store.seed);
    store.seed.load = async () => {
      loads++;
      if (loads === 1) {
        entered.resolve();
        await gate.promise;
      }
      return origLoad();
    };

    // No seed → stages note MissingSeed; enough to exercise run coalesce.
    const p1 = client.sync();
    await entered.promise;
    const p2 = client.sync();
    const p3 = client.sync();
    // In-flight callers share the same Promise (CoalesceTail).
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    gate.resolve();
    const results = await Promise.all([p1, p2, p3]);

    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(results[0]).toBe(Status.MissingSeed);
  });
});
