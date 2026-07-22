import { describe, expect, test } from "vitest";
import { batchByBytes } from "../src/batch";

describe("batchByBytes", () => {
  test("empty input", () => {
    expect(batchByBytes([], () => 1, 10)).toEqual([]);
  });

  test("flushes when next item would exceed limit", () => {
    const items = [
      { n: 1, len: 3 },
      { n: 2, len: 3 },
      { n: 3, len: 10 },
      { n: 4, len: 2 },
    ];
    const batches = batchByBytes(items, (i) => i.len, 5);
    expect(batches.map((b) => b.map((x) => x.n))).toEqual([
      [1],
      [2],
      [3],
      [4],
    ]);
  });

  test("fills batch until limit", () => {
    const batches = batchByBytes(
      [
        { n: 1, len: 2 },
        { n: 2, len: 2 },
        { n: 3, len: 2 },
      ],
      (i) => i.len,
      4,
    );
    expect(batches.map((b) => b.map((x) => x.n))).toEqual([[1, 2], [3]]);
  });

  test("single item larger than limit goes alone", () => {
    const batches = batchByBytes([{ n: 1, len: 100 }], (i) => i.len, 10);
    expect(batches.map((b) => b.map((x) => x.n))).toEqual([[1]]);
  });

  test("exact limit boundary", () => {
    const batches = batchByBytes(
      [
        { n: 1, len: 5 },
        { n: 2, len: 5 },
      ],
      (i) => i.len,
      5,
    );
    expect(batches.map((b) => b.map((x) => x.n))).toEqual([[1], [2]]);
  });
});
