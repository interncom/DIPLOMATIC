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
  opts?: {
    gid?: string;
    pid?: Uint8Array;
    tags?: string[];
    off?: number;
    ctr?: number;
  },
): IOp {
  return {
    eid,
    off: opts?.off ?? 0,
    ctr: opts?.ctr ?? 1,
    type,
    body,
    gid: opts?.gid,
    pid: opts?.pid,
    tags: opts?.tags,
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

    it("lists by tag (multi-value multiEntry)", async () => {
      const goal = await eidAt(2000, 52);
      const other = await eidAt(3000, 53);
      const noTags = await eidAt(4000, 54);
      const tagA = "impl:AAA";
      const tagB = "impl:BBB";

      await db.apply([
        mutate(goal, "goal", { n: "g" }, {
          tags: [tagA, tagB, "", tagA], // empty + dup dropped on apply
        }),
        mutate(other, "goal", { n: "o" }, { tags: [tagA] }),
        mutate(noTags, "goal", { n: "z" }),
        mutate(await eidAt(5000, 55), "task", { n: "t" }, { tags: [tagA] }),
      ]);

      const [byA, stA] = await db.getEntities({ type: "goal", tag: tagA });
      expect(stA).toBe(Status.Success);
      expect(byA).toHaveLength(2);
      const namesA = new Set(byA?.map((e) =>
        e.body && typeof e.body === "object" && "n" in e.body
          ? e.body.n
          : undefined
      ));
      expect(namesA).toEqual(new Set(["g", "o"]));

      const [byB, stB] = await db.getEntities({ type: "goal", tag: tagB });
      expect(stB).toBe(Status.Success);
      expect(byB).toHaveLength(1);
      expect(byB?.[0]?.body).toEqual({ n: "g" });
      expect(byB?.[0]?.tags).toEqual([tagA, tagB]);

      const [emptyTag] = await db.getEntities({ type: "goal", tag: "" });
      expect(emptyTag).toHaveLength(0);
      const [missing] = await db.getEntities({
        type: "goal",
        tag: "impl:nope",
      });
      expect(missing).toHaveLength(0);
    });

    it("reindexes tags on update and delete", async () => {
      const goal = await eidAt(2000, 60);
      const tagA = "impl:AAA";
      const tagB = "impl:BBB";

      await db.apply([
        mutate(goal, "goal", { n: "g" }, { tags: [tagA, tagB], ctr: 1 }),
      ]);
      const [beforeA] = await db.getEntities({ type: "goal", tag: tagA });
      expect(beforeA).toHaveLength(1);

      // Drop tagA; keep tagB.
      await db.apply([
        mutate(goal, "goal", { n: "g2" }, {
          tags: [tagB],
          off: 10,
          ctr: 1,
        }),
      ]);
      const [afterA] = await db.getEntities({ type: "goal", tag: tagA });
      expect(afterA).toHaveLength(0);
      const [afterB] = await db.getEntities({ type: "goal", tag: tagB });
      expect(afterB).toHaveLength(1);
      expect(afterB?.[0]?.tags).toEqual([tagB]);

      // Clear tags.
      await db.apply([
        mutate(goal, "goal", { n: "g3" }, { off: 20, ctr: 1 }),
      ]);
      const [cleared] = await db.getEntities({ type: "goal", tag: tagB });
      expect(cleared).toHaveLength(0);

      // Re-tag then delete entity.
      await db.apply([
        mutate(goal, "goal", { n: "g4" }, {
          tags: [tagA, tagB],
          off: 30,
          ctr: 1,
        }),
      ]);
      await db.apply([{ eid: goal, off: 40, ctr: 2 }]);
      const [delA] = await db.getEntities({ type: "goal", tag: tagA });
      const [delB] = await db.getEntities({ type: "goal", tag: tagB });
      expect(delA).toHaveLength(0);
      expect(delB).toHaveLength(0);
      const [cnt] = await db.countEntities({ type: "goal" });
      expect(cnt).toBe(0);
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

  it("warm + tag query after durable apply", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const goal = await eidAt(2000, 70);
    const tag = "impl:OBJ";

    await durable.apply([
      mutate(goal, "goal", { n: "g" }, { tags: [tag] }),
    ]);

    const [hits, st] = await cache.getEntities({ type: "goal", tag });
    expect(st).toBe(Status.Success);
    expect(hits).toHaveLength(1);
    expect(hits?.[0]?.tags).toEqual([tag]);
  });

  it("apply path keeps tag index coherent", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable, undefined, { indexes: true });
    const goal = await eidAt(2000, 71);
    const tagA = "impl:A";
    const tagB = "impl:B";

    await cache.apply([
      mutate(goal, "goal", { n: "g" }, { tags: [tagA, tagB] }),
    ]);
    const [a1] = await cache.getEntities({ type: "goal", tag: tagA });
    const [b1] = await cache.getEntities({ type: "goal", tag: tagB });
    expect(a1).toHaveLength(1);
    expect(b1).toHaveLength(1);

    await cache.apply([
      mutate(goal, "goal", { n: "g2" }, { tags: [tagB], off: 5, ctr: 1 }),
    ]);
    const [a2] = await cache.getEntities({ type: "goal", tag: tagA });
    const [b2] = await cache.getEntities({ type: "goal", tag: tagB });
    expect(a2).toHaveLength(0);
    expect(b2).toHaveLength(1);
  });
});
