import { describe, expect, test } from "vitest";
import { Status } from "../src/shared/consts";
import { accountLabel, singleAccountLabel } from "../src/stores/label";

// Puts a non-string through the string | undefined parameter.
function sneak(raw: unknown): string | undefined {
  const box: { raw: string | undefined } = { raw: undefined };
  Object.assign(box, { raw });
  return box.raw;
}

describe("accountLabel", () => {
  test("missing or blank is the default account", () => {
    expect(accountLabel(undefined)).toEqual(["", Status.Success]);
    expect(accountLabel("")).toEqual(["", Status.Success]);
    expect(accountLabel("   ")).toEqual(["", Status.Success]);
    expect(accountLabel(" home ")).toEqual(["home", Status.Success]);
  });

  test("a non-string is InvalidParam", () => {
    expect(accountLabel(sneak(1))[1]).toBe(Status.InvalidParam);
  });
});

describe("singleAccountLabel", () => {
  test("an empty store takes the first label", () => {
    expect(singleAccountLabel(undefined, undefined, false)).toEqual([
      "",
      Status.Success,
    ]);
    expect(singleAccountLabel(undefined, " work ", false)).toEqual([
      "work",
      Status.Success,
    ]);
    expect(singleAccountLabel("home", "work", false)).toEqual([
      "work",
      Status.Success,
    ]);
  });

  test("an occupied store rejects a different label", () => {
    expect(singleAccountLabel("home", "home", true)).toEqual([
      "home",
      Status.Success,
    ]);
    expect(singleAccountLabel("home", " home ", true)).toEqual([
      "home",
      Status.Success,
    ]);
    expect(singleAccountLabel("home", undefined, true)[1]).toBe(
      Status.InvalidParam,
    );
    expect(singleAccountLabel("home", "work", true)[1]).toBe(
      Status.InvalidParam,
    );
    expect(singleAccountLabel("home", "   ", true)[1]).toBe(
      Status.InvalidParam,
    );
  });

  test("occupied with no current name accepts the label", () => {
    expect(singleAccountLabel(undefined, "work", true)).toEqual([
      "work",
      Status.Success,
    ]);
  });

  test("a non-string is InvalidParam", () => {
    expect(singleAccountLabel("home", sneak(1), false)[1]).toBe(
      Status.InvalidParam,
    );
  });
});
