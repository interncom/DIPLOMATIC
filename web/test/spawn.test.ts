import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnDiplomaticSyncWorker } from "../src/shared/worker/spawn";

describe("spawn Worker snapshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("later window.Worker wrap is not used", () => {
    const wrap = vi.fn(function () {
      throw new Error("wrapped Worker used");
    });
    vi.stubGlobal("Worker", wrap);
    try {
      spawnDiplomaticSyncWorker();
    } catch (e) {
      expect(String(e)).not.toMatch(/wrapped Worker used/);
    }
    expect(wrap).not.toHaveBeenCalled();
  });
});
