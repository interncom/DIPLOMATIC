// Tests the host-realm cursor helpers.

import { describe, expect, test } from "vitest";
import { nullKDM } from "../src/shared/crypto/derivation";
import {
  cursorOf,
  downloadKey,
  nextCursor,
  projectCursors,
  realmKDM,
  realmKDMs,
} from "../src/stores/cursor";

describe("realm cursors", () => {
  test("realmKDMs always includes the default realm", () => {
    expect(realmKDMs([])).toEqual([nullKDM]);
    expect(realmKDMs([{ label: "inbox", index: 2, prior: [0, 1] }])).toEqual([
      nullKDM,
      { label: "inbox", index: 2 },
      { label: "inbox", index: 0 },
      { label: "inbox", index: 1 },
    ]);
    expect(realmKDMs([{ label: "", index: 0 }])).toEqual([nullKDM]);
  });

  test("cursorOf reads lastSeq for the default realm", () => {
    const row = {
      lastSeq: 4,
      seqs: [{ label: "inbox", index: 1, lastSeq: 9 }],
    };
    expect(cursorOf(row)).toBe(4);
    expect(cursorOf(row, nullKDM)).toBe(4);
    expect(cursorOf(row, { label: "inbox", index: 1 })).toBe(9);
    expect(cursorOf(row, { label: "inbox", index: 0 })).toBe(0);
  });

  test("projectCursors keeps the default row out of seqs", () => {
    expect(projectCursors([])).toEqual({ lastSeq: 0 });
    expect(projectCursors([
      { label: "", index: 0, lastSeq: 4 },
      { label: "inbox", index: 1, lastSeq: 9 },
    ])).toEqual({
      lastSeq: 4,
      seqs: [{ label: "inbox", index: 1, lastSeq: 9 }],
    });
  });

  test("nextCursor advances or replaces", () => {
    expect(nextCursor(4, { lastSeq: 3 })).toBeUndefined();
    expect(nextCursor(4, { lastSeq: 5 })).toBe(5);
    expect(nextCursor(4, { setLastSeq: 0 })).toBe(0);
  });

  test("downloadKey keeps host:seq for the default realm", () => {
    expect(downloadKey("h", 3)).toBe("h:3");
    expect(downloadKey("h", 3, nullKDM)).toBe("h:3");
    expect(downloadKey("h", 3, { label: "inbox", index: 1 })).toBe(
      "h:inbox:1:3",
    );
  });

  test("realmKDM uses the current counter", () => {
    const rows = [{ label: "inbox", index: 2, prior: [1] }];
    expect(realmKDM(undefined, rows)).toBe(nullKDM);
    expect(realmKDM("", rows)).toBe(nullKDM);
    expect(realmKDM("inbox", rows)).toEqual({ label: "inbox", index: 2 });
    expect(realmKDM("other", rows)).toEqual({ label: "other", index: 0 });
  });
});
