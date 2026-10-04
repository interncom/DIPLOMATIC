// Tests how an account gets its database names.

import { describe, expect, test } from "vitest";
import { decodeAccount } from "../src/stores/idb/account";
import {
  assignEnts,
  dataDbName,
  entsDbName,
  placeAccount,
} from "../src/stores/idb/names";

describe("account database placement", () => {
  test("placeAccount keeps an id and a data name, else mints them", () => {
    expect(placeAccount("ab", "custom")).toEqual({
      acct: "ab",
      data: "custom",
    });
    expect(placeAccount("ab", "")).toEqual({
      acct: "ab",
      data: dataDbName("ab"),
    });
    const fresh = placeAccount(undefined, undefined);
    expect(fresh.data).toBe(dataDbName(fresh.acct));
    expect(fresh.acct).toMatch(/^[0-9a-f]{32}$/);
  });

  test("assignEnts keeps a name, else mints one", () => {
    expect(assignEnts("ab", "keep")).toBe("keep");
    expect(assignEnts("ab", undefined)).toBe(entsDbName("ab"));
    expect(assignEnts("ab", "")).toBe(entsDbName("ab"));
  });

  test("decodeAccount requires a label", () => {
    expect(decodeAccount({
      id: "old",
      acct: "abc",
      data: "data-abc",
    })).toBeUndefined();
    expect(decodeAccount({
      label: "",
      acct: "abc",
      data: "data-abc",
      ents: "ents-abc",
    })).toEqual({
      label: "",
      acct: "abc",
      data: "data-abc",
      ents: "ents-abc",
    });
    expect(decodeAccount({ id: "" })).toBeUndefined();
  });
});
