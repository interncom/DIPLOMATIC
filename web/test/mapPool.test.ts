import { describe, expect, test } from "vitest";
import { mapPool } from "../src/mapPool";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapPool", () => {
  test("empty input returns empty array", async () => {
    const out = await mapPool([], 8, async (x) => x);
    expect(out).toEqual([]);
  });

  test("preserves input order despite reverse completion", async () => {
    const items = [1, 2, 3, 4, 5];
    // Longer delay for earlier indices so they finish last.
    const out = await mapPool(items, 5, async (n, i) => {
      await delay((items.length - i) * 5);
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  test("passes correct item and index", async () => {
    const items = ["a", "b", "c"];
    const out = await mapPool(items, 2, async (item, index) => ({
      item,
      index,
    }));
    expect(out).toEqual([
      { item: "a", index: 0 },
      { item: "b", index: 1 },
      { item: "c", index: 2 },
    ]);
  });

  test("serial when concurrency is 1", async () => {
    const order: number[] = [];
    await mapPool([0, 1, 2], 1, async (n) => {
      order.push(n);
      await delay(5);
      return n;
    });
    expect(order).toEqual([0, 1, 2]);
  });

  test("clamps concurrency < 1 to 1 (serial)", async () => {
    const starts: number[] = [];
    await mapPool([0, 1, 2], 0, async (n) => {
      starts.push(n);
      await delay(5);
      return n;
    });
    // With one worker, starts are strictly sequential in order.
    expect(starts).toEqual([0, 1, 2]);

    const startsNeg: number[] = [];
    await mapPool([0, 1], -3, async (n) => {
      startsNeg.push(n);
      await delay(5);
      return n;
    });
    expect(startsNeg).toEqual([0, 1]);
  });

  test("caps concurrency at item count", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const n = 3;
    await mapPool(Array.from({ length: n }, (_, i) => i), 100, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(15);
      inFlight -= 1;
      return 0;
    });
    // Never more workers than items.
    expect(maxInFlight).toBeLessThanOrEqual(n);
    expect(maxInFlight).toBeGreaterThanOrEqual(1);
  });

  test("respects concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const conc = 3;
    const n = 20;
    await mapPool(Array.from({ length: n }, (_, i) => i), conc, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight -= 1;
      return true;
    });
    expect(maxInFlight).toBeLessThanOrEqual(conc);
    // With 20 items and delay, we should have hit the cap.
    expect(maxInFlight).toBe(conc);
  });

  test("single item", async () => {
    const out = await mapPool(["only"], 8, async (x, i) => `${x}:${i}`);
    expect(out).toEqual(["only:0"]);
  });

  test("propagates rejection from fn", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        await delay(5);
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  test("runs all items (no dropped work)", async () => {
    const n = 50;
    const seen = new Set<number>();
    const out = await mapPool(
      Array.from({ length: n }, (_, i) => i),
      7,
      async (i) => {
        seen.add(i);
        await delay(1);
        return i * i;
      },
    );
    expect(seen.size).toBe(n);
    expect(out).toEqual(Array.from({ length: n }, (_, i) => i * i));
  });

  test("works with readonly arrays", async () => {
    const items: readonly number[] = Object.freeze([1, 2, 3]);
    const out = await mapPool(items, 2, async (x) => x + 1);
    expect(out).toEqual([2, 3, 4]);
  });
});
