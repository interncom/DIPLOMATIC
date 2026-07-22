import { describe, expect, test } from "vitest";
import { makeEID } from "../src/shared/codecs/eid";
import { Status } from "../src/shared/consts";
import type { EntityID } from "../src/shared/types";
import {
  compareHeadHlcDesc,
  headUpdatedAtMs,
  sortByHlcDesc,
} from "../src/hlc";

function eidAt(tsMs: number, idFill = 1): EntityID {
  const [eid, st] = makeEID({
    id: new Uint8Array(8).fill(idFill),
    ts: new Date(tsMs),
  });
  expect(st).toBe(Status.Success);
  if (st !== Status.Success) {
    throw new Error("makeEID failed");
  }
  return eid;
}

describe("hlc", () => {
  test("headUpdatedAtMs is eid.ts + off", () => {
    const eid = eidAt(1_000_000);
    expect(headUpdatedAtMs({ eid, off: 50, ctr: 0 })).toBe(1_000_050);
  });

  test("compareHeadHlcDesc orders newest first", () => {
    const eid = eidAt(0);
    const older = { eid, off: 10, ctr: 0 };
    const newer = { eid, off: 20, ctr: 1 };
    expect(compareHeadHlcDesc(newer, older)).toBeLessThan(0);
    expect(compareHeadHlcDesc(older, newer)).toBeGreaterThan(0);
  });

  test("same updatedAt: higher ctr first", () => {
    const eid = eidAt(0);
    const a = { eid, off: 5, ctr: 1 };
    const b = { eid, off: 5, ctr: 3 };
    expect(compareHeadHlcDesc(b, a)).toBeLessThan(0);
  });

  test("sortByHlcDesc sorts mixed eids newest-first", () => {
    const e1 = eidAt(1000, 1);
    const e2 = eidAt(2000, 2);
    const items = [
      { label: "old-e1", head: { eid: e1, off: 0, ctr: 0 } },
      { label: "new-e2", head: { eid: e2, off: 100, ctr: 0 } },
      { label: "mid-e1", head: { eid: e1, off: 50, ctr: 1 } },
    ];
    const sorted = sortByHlcDesc(items, (x) => x.head);
    expect(sorted.map((x) => x.label)).toEqual([
      "new-e2", // 2100
      "mid-e1", // 1050
      "old-e1", // 1000
    ]);
  });

  test("sortByHlcDesc does not mutate input", () => {
    const eid = eidAt(0);
    const items = [
      { head: { eid, off: 1, ctr: 0 } },
      { head: { eid, off: 9, ctr: 0 } },
    ];
    const copy = items.slice();
    sortByHlcDesc(items, (x) => x.head);
    expect(items).toEqual(copy);
  });
});
