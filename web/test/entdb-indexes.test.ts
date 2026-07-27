import { beforeEach, describe, expect, it } from "vitest";
import { EntDBMemory } from "../src/entdb/memory";
import { CachedEntDB } from "../src/entdb/cached";
import { Status } from "../src/shared/consts";
import { IOp } from "../src/shared/types";
import libsodiumCrypto from "../src/crypto";
import { makeEID } from "../src/shared/codecs/eid";

async function eidAt(tsMs: number, fill = 1) {
  const id = await libsodiumCrypto.genRandomBytes(8);
  id.fill(fill);
  const [eid, st] = makeEID({ id, ts: new Date(tsMs) });
  expect(st).toBe(Status.Success);
  if (!eid) throw new Error("eid");
  return eid;
}

function mutate(
  eid: Uint8Array,
  type: string,
  body: unknown,
  opts?: { gid?: string; pid?: Uint8Array; off?: number; ctr?: number },
): IOp {
  return {
    eid,
    off: opts?.off ?? 0,
    ctr: opts?.ctr ?? 1,
    type,
    body,
    gid: opts?.gid,
    pid: opts?.pid,
  };
}

describe("EntDBMemory indexes", () => {
  describe.each([
    { indexes: true as const, label: "indexes on" },
    { indexes: false as const, label: "indexes off" },
  ])("$label", ({ indexes }) => {
    let db: EntDBMemory;

    beforeEach(() => {
      db = new EntDBMemory([], { indexes });
    });

    it("lists by type, pid, gid", async () => {
      const parent = await eidAt(1000, 1);
      const childA = await eidAt(2000, 2);
      const childB = await eidAt(3000, 3);
      const other = await eidAt(4000, 4);

      await db.apply([
        mutate(parent, "project", { n: "p" }),
        mutate(childA, "goal", { n: "a" }, { pid: parent, gid: "w1" }),
        mutate(childB, "goal", { n: "b" }, { pid: parent, gid: "w2" }),
        mutate(other, "goal", { n: "x" }, { gid: "w1" }),
      ]);

      const [byType, stT] = await db.getEntities({ type: "goal" });
      expect(stT).toBe(Status.Success);
      expect(byType).toHaveLength(3);

      const [byPid, stP] = await db.getEntities({ type: "goal", pid: parent });
      expect(stP).toBe(Status.Success);
      expect(byPid).toHaveLength(2);
      const names = new Set(byPid?.map((e) => {
        if (e.body && typeof e.body === "object" && "n" in e.body) {
          return e.body.n;
        }
        return undefined;
      }));
      expect(names).toEqual(new Set(["a", "b"]));

      const [byGid, stG] = await db.getEntities({ type: "goal", gid: "w1" });
      expect(stG).toBe(Status.Success);
      expect(byGid).toHaveLength(2);

      const [count, stC] = await db.countEntities({ type: "goal" });
      expect(stC).toBe(Status.Success);
      expect(count).toBe(3);
    });

    it("reindexes on type/pid/gid change and delete", async () => {
      const parent1 = await eidAt(1000, 10);
      const parent2 = await eidAt(1100, 11);
      const child = await eidAt(2000, 12);

      await db.apply([
        mutate(parent1, "project", { n: "p1" }),
        mutate(parent2, "project", { n: "p2" }),
        mutate(child, "goal", { n: "c" }, { pid: parent1, gid: "g1", ctr: 1 }),
      ]);

      // Move parent + group + type via newer op.
      await db.apply([
        mutate(child, "task", { n: "c2" }, {
          pid: parent2,
          gid: "g2",
          off: 10,
          ctr: 1,
        }),
      ]);

      const [oldPid] = await db.getEntities({ type: "goal", pid: parent1 });
      expect(oldPid).toHaveLength(0);
      const [oldType] = await db.getEntities({ type: "goal" });
      expect(oldType).toHaveLength(0);
      const [oldGid] = await db.getEntities({ type: "task", gid: "g1" });
      expect(oldGid).toHaveLength(0);

      const [newPid] = await db.getEntities({ type: "task", pid: parent2 });
      expect(newPid).toHaveLength(1);
      const [newGid] = await db.getEntities({ type: "task", gid: "g2" });
      expect(newGid).toHaveLength(1);

      // Delete
      await db.apply([{
        eid: child,
        off: 20,
        ctr: 2,
      }]);
      const [afterDel] = await db.getEntities({ type: "task", pid: parent2 });
      expect(afterDel).toHaveLength(0);
      const [cnt] = await db.countEntities({ type: "task" });
      expect(cnt).toBe(0);
    });
  });

  it("init ents are indexed", async () => {
    const eid = await eidAt(5000, 20);
    const db = new EntDBMemory([
      {
        eid,
        type: "note",
        createdAt: new Date(5000),
        updatedAt: new Date(5000),
        ctr: 0,
        body: { x: 1 },
      },
    ]);
    const [ents] = await db.getEntities({ type: "note" });
    expect(ents).toHaveLength(1);
  });
});

describe("CachedEntDB indexes via put/del", () => {
  it("warm + pid query after durable apply", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const parent = await eidAt(1000, 30);
    const child = await eidAt(2000, 31);

    await durable.apply([
      mutate(parent, "project", { n: "p" }),
      mutate(child, "goal", { n: "c" }, { pid: parent }),
    ]);

    const [kids, st] = await cache.getEntities({ type: "goal", pid: parent });
    expect(st).toBe(Status.Success);
    expect(kids).toHaveLength(1);
    expect(kids?.[0]?.body).toEqual({ n: "c" });
  });

  it("apply path keeps pid index coherent", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable, undefined, { indexes: true });
    const parent = await eidAt(1000, 40);
    const child = await eidAt(2000, 41);

    await cache.apply([
      mutate(parent, "project", { n: "p" }),
      mutate(child, "goal", { n: "c" }, { pid: parent }),
    ]);

    const [kids] = await cache.getEntities({ type: "goal", pid: parent });
    expect(kids).toHaveLength(1);
  });
});
