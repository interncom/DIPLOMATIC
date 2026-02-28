import { beforeEach, describe, expect, it } from "vitest";
import { EntDBMemory } from "../src/entdb/memory";
import { Status } from "../src/shared/consts";
import { IOp } from "../src/shared/types";
import libsodiumCrypto from "../src/crypto";
import { makeEID } from "../src/shared/codecs/eid";

describe("EntDBMemory.apply()", () => {
  let db: EntDBMemory;

  beforeEach(() => {
    db = new EntDBMemory();
  });

  describe("no pre-existing entity", () => {
    it("creates new entity with op data", async () => {
      const id = await libsodiumCrypto.genRandomBytes(8);
      const eidObj = { id, ts: new Date(1000) };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        expect(statEid).toEqual(Status.Success);
        return;
      }

      const op: IOp = {
        off: 0,
        ctr: 1,
        eid,
        gid: "group1",
        type: "test",
        body: { data: "new" },
      };

      const result = await db.apply([op]);
      expect(result[0]).toBe(Status.Success);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity).toEqual({
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

  describe("pre-existing entity older than op", () => {
    it("overwrites body and updates timestamps", async () => {
      const id = await libsodiumCrypto.genRandomBytes(8);
      const t0 = new Date(500);
      const eidObj = { id, ts: t0 };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        expect(statEid).toEqual(Status.Success);
        return;
      }

      // First, apply an older op
      const oldOp: IOp = {
        off: 0,
        ctr: 2,
        eid,
        type: "test",
        body: { data: "old" },
      };
      await db.apply([oldOp]);

      // Then apply newer op
      const newOp: IOp = {
        off: 10,
        ctr: 2,
        eid,
        gid: "group2",
        // pid: new Uint8Array(16).fill(3),
        type: "test2",
        body: { data: "new" },
      };
      const result = await db.apply([newOp]);
      expect(result[0]).toBe(Status.Success);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity?.body).toEqual({ data: "new" });
      expect(entity?.createdAt).toEqual(new Date(500));
      expect(entity?.updatedAt).toEqual(new Date(510));
      expect(entity?.ctr).toBe(2);
    });

    it("ctr tiebreaker: equal ctr keeps current", async () => {
      const id = await libsodiumCrypto.genRandomBytes(8);
      const eidObj = { id, ts: new Date(1000) };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        expect(statEid).toEqual(Status.Success);
        return;
      }

      await db.apply([{
        off: 0,
        ctr: 5,
        eid,
        type: "test",
        body: { data: "higher" },
      }]);

      const op: IOp = {
        off: 0,
        ctr: 1,
        eid,
        type: "test",
        body: { data: "lower ctr" },
      };
      await db.apply([op]);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity?.body).toEqual({ data: "higher" });
      expect(entity?.ctr).toBe(5);
    });

    it("ctr tiebreaker: lower ctr keeps current", async () => {
      const id = await libsodiumCrypto.genRandomBytes(8);
      const eidObj = { id, ts: new Date(1000) };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        expect(statEid).toEqual(Status.Success);
        return;
      }

      await db.apply([{
        off: 0,
        ctr: 5,
        eid,
        type: "test",
        body: { data: "higher" },
      }]);

      // Same ts, lower ctr
      const op: IOp = {
        off: 0,
        ctr: 2,
        eid,
        type: "test",
        body: { data: "lower ctr" },
      };
      await db.apply([op]);

      const [entity, entityStatus] = await db.getEnt(eid);
      expect(entityStatus).toBe(Status.Success);
      expect(entity?.body).toEqual({ data: "higher" });
      expect(entity?.ctr).toBe(5);
    });
  });
});
