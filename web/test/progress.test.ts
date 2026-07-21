import { describe, expect, test } from "vitest";
import {
  defaultPeekProgressEvery,
  idleProgress,
  shouldEmitItemProgress,
} from "../src/progress";
import {
  progressFromUnknown,
  xferStateFromUnknown,
} from "../src/worker/protocol";

describe("shouldEmitItemProgress", () => {
  test("emits first, every N, and last", () => {
    const every = 50;
    const total = 120;
    const hits: number[] = [];
    for (let done = 1; done <= total; done++) {
      if (shouldEmitItemProgress(done, total, every)) {
        hits.push(done);
      }
    }
    expect(hits[0]).toBe(1);
    expect(hits).toContain(50);
    expect(hits).toContain(100);
    expect(hits[hits.length - 1]).toBe(120);
  });

  test("default stride is 50 heads", () => {
    expect(defaultPeekProgressEvery).toBe(50);
  });

  test("empty totals never emit", () => {
    expect(shouldEmitItemProgress(0, 0, 50)).toBe(false);
    expect(shouldEmitItemProgress(1, 0, 50)).toBe(false);
  });
});

describe("xferState progress snapshot parsing", () => {
  test("idleProgress constant", () => {
    expect(idleProgress).toEqual({ phase: "idle" });
  });

  test("progressFromUnknown accepts phase ticks", () => {
    expect(progressFromUnknown({
      phase: "pull",
      host: "h",
      done: 3,
      total: 10,
    })).toEqual({
      phase: "pull",
      host: "h",
      done: 3,
      total: 10,
    });
    expect(progressFromUnknown({ phase: "nope" })).toBeUndefined();
  });

  test("xferStateFromUnknown includes progress", () => {
    expect(xferStateFromUnknown({
      numUploads: 1,
      numDownloads: 2,
      progress: { phase: "push", done: 1, total: 4 },
    })).toEqual({
      numUploads: 1,
      numDownloads: 2,
      progress: { phase: "push", done: 1, total: 4 },
    });
    // Legacy messages without progress → idle
    expect(xferStateFromUnknown({
      numUploads: 0,
      numDownloads: 0,
    })).toEqual({
      numUploads: 0,
      numDownloads: 0,
      progress: { phase: "idle" },
    });
  });
});
