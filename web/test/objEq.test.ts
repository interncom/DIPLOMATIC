// Checks for JSON object equality.

import { describe, expect, test } from "vitest";
import { objEq } from "../src/objEq";

describe("objEq", () => {
  test("matches plain objects and arrays by JSON text", () => {
    expect(objEq({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(objEq({ a: 1, nest: { b: true } }, { a: 1, nest: { b: true } }))
      .toBe(true);
    expect(objEq([1, { a: true }], [1, { a: true }])).toBe(true);
    const same = { a: 1 };
    expect(objEq(same, same)).toBe(true);
    expect(objEq({}, {})).toBe(true);
  });

  test("differs when a field, key, or order differs", () => {
    expect(objEq({ a: 1 }, { a: 2 })).toBe(false);
    expect(objEq({ a: 1 }, { b: 1 })).toBe(false);
    expect(objEq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(objEq([1, 2], [2, 1])).toBe(false);
  });

  test("treats an omitted field like a missing one", () => {
    expect(objEq({ a: undefined }, {})).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(objEq(null, null)).toBe(false);
    expect(objEq(null, {})).toBe(false);
    expect(objEq(1, 1)).toBe(false);
    expect(objEq("a", "a")).toBe(false);
    expect(objEq(undefined, undefined)).toBe(false);
  });

  test("rejects values JSON cannot stringify", () => {
    const cyc: { self?: unknown } = {};
    cyc.self = cyc;
    expect(objEq(cyc, cyc)).toBe(false);
    expect(objEq({ n: 1n }, { n: 1n })).toBe(false);
  });
});
