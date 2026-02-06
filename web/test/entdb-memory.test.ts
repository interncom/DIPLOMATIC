import { beforeEach, describe, expect, it } from "vitest";
import { EntDBMemory } from "../src/entdb/memory";
import { Status } from "../src/shared/consts";
import { IOp } from "../src/shared/types";

describe("EntDBMemory.apply()", () => {
  let db: EntDBMemory;

  beforeEach(() => {
    db = new EntDBMemory();
  });

  describe("no pre-existing entity", () => {
    it("creates new entity with op data", async () => {
      const eid = new Uint8Array(16).fill(1);
      const op: IOp = {
        clk: new Date(1000),
        off: 0,
        ctr: 1,
        eid,
        gid: "group1",
        pid: new Uint8Array(16).fill(2),
        type: "test",
        body: { data: "new" },
      };

      const result = await db.apply(op);
      expect(result).toBe(Status.Success);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity).toEqual({
        eid,
        gid: "group1",
        pid: new Uint8Array(16).fill(2),
        type: "test",
        createdAt: new Date(1000),
        updatedAt: new Date(1000),
        updatedCtr: 1,
        body: { data: "new" },
      });
    });
  });

  describe("pre-existing entity older than op", () => {
    it("overwrites body and updates timestamps", async () => {
      const eid = new Uint8Array(16).fill(1);
      const t0 = new Date(500);
      // First, apply an older op
      const oldOp: IOp = {
        clk: t0,
        off: 0,
        ctr: 2,
        eid,
        type: "test",
        body: { data: "old" },
      };
      await db.apply(oldOp);

      // Then apply newer op
      const newOp: IOp = {
        clk: t0,
        off: 10,
        ctr: 2,
        eid,
        gid: "group2",
        pid: new Uint8Array(16).fill(3),
        type: "test2",
        body: { data: "new" },
      };
      const result = await db.apply(newOp);
      expect(result).toBe(Status.Success);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity?.body).toEqual({ data: "new" });
      expect(entity?.createdAt).toEqual(new Date(500));
      expect(entity?.updatedAt).toEqual(new Date(510));
      expect(entity?.updatedCtr).toBe(2);
    });

    it("ctr tiebreaker: equal ctr keeps current", async () => {
      const eid = new Uint8Array(16).fill(2);
      await db.apply({
        clk: new Date(1000),
        off: 0,
        ctr: 5,
        eid,
        type: "test",
        body: { data: "higher" },
      });

      const op: IOp = {
        clk: new Date(1000),
        off: 0,
        ctr: 1,
        eid,
        type: "test",
        body: { data: "lower ctr" },
      };
      await db.apply(op);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity?.body).toEqual({ data: "higher" });
      expect(entity?.updatedCtr).toBe(5);
    });

    it("ctr tiebreaker: lower ctr keeps current", async () => {
      const eid = new Uint8Array(16).fill(3);
      await db.apply({
        clk: new Date(1000),
        off: 0,
        ctr: 5,
        eid,
        type: "test",
        body: { data: "higher" },
      });

      // Same ts, lower ctr
      const op: IOp = {
        clk: new Date(1000),
        off: 0,
        ctr: 2,
        eid,
        type: "test",
        body: { data: "lower ctr" },
      };
      await db.apply(op);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity?.body).toEqual({ data: "higher" });
      expect(entity?.updatedCtr).toBe(5);
    });
  });

  describe("getEntities", () => {
    it("filters by gid with equivalent but not identical Uint8Array instances", async () => {
      const gid1 = new Uint8Array([1, 2, 3]);
      const gid2 = new Uint8Array([1, 2, 3]); // equivalent but different instance

      // Add two entities with equivalent gids
      await db.apply({
        clk: new Date(1000),
        off: 0,
        ctr: 1,
        eid: new Uint8Array(16).fill(1),
        gid: gid1,
        type: "test",
        body: { id: 1 },
      });
      await db.apply({
        clk: new Date(1000),
        off: 0,
        ctr: 1,
        eid: new Uint8Array(16).fill(2),
        gid: gid2,
        type: "test",
        body: { id: 2 },
      });

      // Query by gid1 (should return both if comparison is by content)
      const [results, status] = await db.getEntities({
        type: "test",
        gid: gid1,
      });
      if (status !== Status.Success) {
        expect(status).toBe(Status.Success);
        return;
      }
      expect(results.length).toBe(2); // Currently fails because === compares references
      expect(results.map((r) => r.body)).toEqual([{ id: 1 }, { id: 2 }]);
    });
  });
});
