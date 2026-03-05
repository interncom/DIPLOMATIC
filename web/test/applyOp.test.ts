import { describe, expect, it } from "vitest";
import { applyOp } from "../src/entdb/entdb";
import { Status } from "../src/shared/consts";
import { IOp } from "../src/shared/types";
import libsodiumCrypto from "../src/crypto";
import { makeEID } from "../src/shared/codecs/eid";

const id = await libsodiumCrypto.genRandomBytes(8);
const eidObj = { id, ts: new Date(1000) };
const [eid, statEid] = makeEID(eidObj);
if (statEid !== Status.Success) {
  throw new Error("Failed to generate eid");
}

describe("applyOp", () => {

  describe("curr is undefined", () => {
    it("op is a delete", () => {
      const op: IOp = {
        off: 0,
        ctr: 1,
        eid,
      };

      const [result, stat] = applyOp(undefined, op);
      expect(stat).toBe(Status.Success);
      expect(result).toBeUndefined();
    });

    it("op is a mutate", () => {
      const op: IOp = {
        off: 0,
        ctr: 1,
        eid,
        gid: "group1",
        type: "test",
        body: { data: "new" },
      };

      const [result, stat] = applyOp(undefined, op);
      expect(stat).toBe(Status.Success);
      expect(result).toEqual({
        eid,
        gid: "group1",
        type: "test",
        createdAt: new Date(1000),
        updatedAt: new Date(1000),
        ctr: 1,
        body: { data: "new" },
      });
    });
  });

  describe("curr is defined", () => {
    const curr = {
      eid,
      gid: "group1",
      type: "test",
      createdAt: new Date(1000),
      updatedAt: new Date(1500),
      ctr: 5,
      body: { data: "existing" },
    };

    it("op is obsolete (same updatedAt)", () => {
      const op: IOp = {
        off: 500, // 1000 + 500 = 1500, same as curr.updatedAt
        ctr: 2,
        eid,
        gid: "group2",
        type: "test",
        body: { data: "obsolete" },
      };

      const [result, stat] = applyOp(curr, op);
      expect(stat).toBe(Status.NoChange);
      expect(result).toBeUndefined();
    });

    it("op is obsolete (earlier updatedAt)", () => {
      const op: IOp = {
        off: 400, // 1000 + 400 = 1400 < 1500
        ctr: 2,
        eid,
        gid: "group2",
        type: "test",
        body: { data: "obsolete" },
      };

      const [result, stat] = applyOp(curr, op);
      expect(stat).toBe(Status.NoChange);
      expect(result).toBeUndefined();
    });

    it("op is more recent, delete", () => {
      const op: IOp = {
        off: 600, // 1000 + 600 = 1600 > 1500
        ctr: 6,
        eid,
      };

      const [result, stat] = applyOp(curr, op);
      expect(stat).toBe(Status.Success);
      expect(result).toBeUndefined();
    });

    it("op is more recent, mutate", () => {
      const op: IOp = {
        off: 600, // 1000 + 600 = 1600 > 1500
        ctr: 6,
        eid,
        gid: "group2",
        type: "test2",
        body: { data: "updated" },
      };

      const [result, stat] = applyOp(curr, op);
      expect(stat).toBe(Status.Success);
      expect(result).toEqual({
        eid,
        gid: "group2",
        type: "test2",
        createdAt: new Date(1000),
        updatedAt: new Date(1600),
        ctr: 6,
        body: { data: "updated" },
      });
    });
  });
});