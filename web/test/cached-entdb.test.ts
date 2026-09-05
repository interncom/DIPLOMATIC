import { describe, expect, test } from "vitest";
import { encode } from "@msgpack/msgpack";
import { CachedEntDB } from "../src/entdb/cached";
import { EntDBMemory } from "../src/entdb/memory";
import { revFromEntity } from "../src/entdb/entdb";
import { msgToOp } from "../src/state";
import { Status } from "../src/shared/consts";
import { makeEID } from "../src/shared/codecs/eid";
import type { EntityID, IMessage, IOp } from "../src/shared/types";

/** Resolve when `notifies` has at least `want` entries. */
function waitNotifies(notifies: unknown[], want: number): Promise<void> {
  if (notifies.length >= want) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (notifies.length >= want) {
        resolve();
        return;
      }
      if (Date.now() - t0 > 1000) {
        reject(new Error(`notify timeout: ${notifies.length} < ${want}`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

async function mutateOp(
  body: unknown,
  type: string,
  eidTs = new Date(1000),
  off = 0,
  ctr = 0,
  idFill = 1,
): Promise<IOp> {
  const id = new Uint8Array(8).fill(idFill);
  const [eid, st] = makeEID({ id, ts: eidTs });
  expect(st).toBe(Status.Success);
  if (!eid) throw new Error("eid");
  const bod = encode({ body });
  const msg: IMessage = { eid, off, ctr, typ: type, len: bod.length, bod };
  const [op, stOp] = msgToOp(msg);
  expect(stOp).toBe(Status.Success);
  if (!op) throw new Error("op");
  return op;
}

describe("CachedEntDB", () => {
  test("apply notifies immediately then matches durable", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const notifies: string[][] = [];
    cache.subscribe((types) => notifies.push([...types]));

    const op = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0);
    await cache.apply([op]);

    expect(notifies.length).toBeGreaterThanOrEqual(1);
    expect(notifies[0]).toContain("note");

    const [d] = await durable.getEntities({ type: "note" });
    const [m] = await cache.getEntities({ type: "note" });
    expect(m).toHaveLength(1);
    expect(m?.[0]?.body).toEqual(d?.[0]?.body);
  });

  test("after apply, mem matches durable even if durable rejects op", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const newer = await mutateOp({ n: 9 }, "note", new Date(1000), 100, 1);
    await durable.apply([newer]);
    await cache.ingestFromDurable([newer.eid]);

    const older = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0);
    await cache.apply([older]);

    const [d] = await durable.getEntities({ type: "note" });
    const [m] = await cache.getEntities({ type: "note" });
    expect(d?.[0]?.body).toEqual({ n: 9 });
    expect(m?.[0]?.body).toEqual({ n: 9 });
  });

  test("getEntities warms from durable", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const op = await mutateOp({ n: 2 }, "todo", new Date(2000), 0, 0);
    await durable.apply([op]);

    const [after, st] = await cache.getEntities({ type: "todo" });
    expect(st).toBe(Status.Success);
    expect(after).toHaveLength(1);
    expect(after?.[0]?.body).toEqual({ n: 2 });
    if (after?.[0]) {
      expect(revFromEntity(after[0]).ctr).toBe(0);
    }
  });

  // Regression: writing a row before the first list must not mark the type
  // warm with only that row in mem (would hide every other durable row).
  test("apply before first list still warms full type from durable", async () => {
    const durable = new EntDBMemory();
    const existing = await mutateOp({ n: 1 }, "diary", new Date(1000), 0, 0, 1);
    await durable.apply([existing]);

    const cache = new CachedEntDB(durable);
    const created = await mutateOp({ n: 2 }, "diary", new Date(2000), 0, 0, 2);
    await cache.apply([created]);

    const [ents, st] = await cache.getEntities({ type: "diary" });
    expect(st).toBe(Status.Success);
    expect(ents).toHaveLength(2);
    const bodies = ents?.map((e) => e.body).sort((a, b) =>
      (a as { n: number }).n - (b as { n: number }).n
    );
    expect(bodies).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("getEnt before first list still warms full type from durable", async () => {
    const durable = new EntDBMemory();
    const a = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0, 1);
    const b = await mutateOp({ n: 2 }, "note", new Date(2000), 0, 0, 2);
    await durable.apply([a, b]);

    const cache = new CachedEntDB(durable);
    const [one, st1] = await cache.getEnt(a.eid);
    expect(st1).toBe(Status.Success);
    expect(one?.body).toEqual({ n: 1 });

    const [ents, st] = await cache.getEntities({ type: "note" });
    expect(st).toBe(Status.Success);
    expect(ents).toHaveLength(2);
  });

  test("ingestFromDurable pulls eids only and notifies types on change", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const op = await mutateOp({ n: 1 }, "item", new Date(1000), 0, 0);
    await cache.apply([op]);

    let n = 0;
    const heard: string[] = [];
    cache.subscribe((types) => {
      n += 1;
      heard.push(...types);
    });

    // Same durable rev — no change.
    await cache.ingestFromDurable([op.eid]);
    expect(n).toBe(0);

    // Peer write on same eid.
    const peer = await mutateOp({ n: 3 }, "item", new Date(1000), 50, 1);
    await durable.apply([peer]);
    await cache.ingestFromDurable([peer.eid]);
    expect(n).toBe(1);
    expect(heard).toContain("item");

    const [m] = await cache.getEntities({ type: "item" });
    expect(m?.[0]?.body).toEqual({ n: 3 });
  });

  test("newest-first delete then older mutate stays dead", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const create = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0);
    const del: IOp = { eid: create.eid, off: 50, ctr: 1 };
    // Newest first (rebuild / catch-up order).
    await cache.apply([del, create]);

    const [live] = await cache.getEntities({ type: "note" });
    expect(live).toHaveLength(0);
    const [ent] = await cache.getEnt(create.eid);
    expect(ent).toBeUndefined();
    const [row] = await cache.getRow(create.eid);
    expect(row).toEqual({
      eid: create.eid,
      updatedAt: new Date(1050),
      ctr: 1,
    });
    const [dRow] = await durable.getRow(create.eid);
    expect(dRow).toEqual(row);
  });

  test("getEnt read-through on cold eid", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const op = await mutateOp({ n: 7 }, "x", new Date(3000), 0, 0, 9);
    await durable.apply([op]);
    const eid = op.eid as EntityID;

    const [ent, st] = await cache.getEnt(eid);
    expect(st).toBe(Status.Success);
    expect(ent?.body).toEqual({ n: 7 });
  });

  test("warm getEntities does not re-hit durable", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const op = await mutateOp({ n: 2 }, "todo", new Date(2000), 0, 0);
    await durable.apply([op]);

    const [first, st1] = await cache.getEntities({ type: "todo" });
    expect(st1).toBe(Status.Success);
    expect(first).toHaveLength(1);

    let durableLists = 0;
    const orig = durable.getEntities.bind(durable);
    durable.getEntities = async (q) => {
      durableLists += 1;
      return orig(q);
    };

    const [second, st2] = await cache.getEntities({ type: "todo" });
    expect(st2).toBe(Status.Success);
    expect(second).toHaveLength(1);
    expect(durableLists).toBe(0);

    const [n, stN] = await cache.countEntities({ type: "todo" });
    expect(stN).toBe(Status.Success);
    expect(n).toBe(1);
    expect(durableLists).toBe(0);
  });

  // Load-bearing: UI must see the write while durable.apply is still held.
  test("apply notifies and serves mem before durable.apply", async () => {
    const durable = new EntDBMemory();
    let releaseApply = () => {};
    const applyHold = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const origApply = durable.apply.bind(durable);
    durable.apply = async (ops) => {
      await applyHold;
      return origApply(ops);
    };
    const origGetRow = durable.getRow.bind(durable);
    let getRows = 0;
    let releaseGet = () => {};
    const getHold = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    durable.getRow = async (eid) => {
      getRows += 1;
      await getHold;
      return origGetRow(eid);
    };

    const cache = new CachedEntDB(durable);
    // Warm so list after notify does not serialize on the write chain.
    await cache.getEntities({ type: "note" });

    const notifies: string[][] = [];
    cache.subscribe((types) => notifies.push([...types]));

    const op1 = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0, 1);
    const p1 = cache.apply([op1]);
    await waitNotifies(notifies, 1);
    expect(getRows).toBe(0);
    const [m1] = await cache.getEntities({ type: "note" });
    expect(m1).toHaveLength(1);
    expect(m1?.[0]?.body).toEqual({ n: 1 });
    const [d1] = await durable.getEntities({ type: "note" });
    expect(d1).toHaveLength(0);

    const op2 = await mutateOp({ n: 2 }, "note", new Date(1000), 50, 1, 1);
    const p2 = cache.apply([op2]);
    await waitNotifies(notifies, 2);
    expect(getRows).toBe(0);
    const [m2] = await cache.getEntities({ type: "note" });
    expect(m2?.[0]?.body).toEqual({ n: 2 });

    releaseGet();
    releaseApply();
    await p1;
    await p2;
    const [done] = await durable.getEntities({ type: "note" });
    expect(done?.[0]?.body).toEqual({ n: 2 });
  });

  test("second apply emits before first durable.apply (distinct eids)", async () => {
    const durable = new EntDBMemory();
    let releaseApply = () => {};
    const applyHold = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const origApply = durable.apply.bind(durable);
    durable.apply = async (ops) => {
      await applyHold;
      return origApply(ops);
    };

    const cache = new CachedEntDB(durable);
    await cache.getEntities({ type: "note" });

    const notifies: string[][] = [];
    cache.subscribe((types) => notifies.push([...types]));

    const op1 = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0, 1);
    const op2 = await mutateOp({ n: 2 }, "note", new Date(2000), 0, 0, 2);
    const p1 = cache.apply([op1]);
    await waitNotifies(notifies, 1);
    const p2 = cache.apply([op2]);
    await waitNotifies(notifies, 2);
    const [mem] = await cache.getEntities({ type: "note" });
    expect(mem).toHaveLength(2);
    const [dur] = await durable.getEntities({ type: "note" });
    expect(dur).toHaveLength(0);

    releaseApply();
    await p1;
    await p2;
    const [after] = await durable.getEntities({ type: "note" });
    expect(after).toHaveLength(2);
  });

  // Persist must be queued before subscribe handlers run. Otherwise a
  // cold getEntities in a listener this.run(warmType)s ahead of durable.apply.
  test("subscribe handlers do not block durable.apply", async () => {
    const durable = new EntDBMemory();
    let applyStarted = 0;
    let releaseApply = () => {};
    const applyHold = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const origApply = durable.apply.bind(durable);
    durable.apply = async (ops) => {
      applyStarted += 1;
      await applyHold;
      return origApply(ops);
    };
    const cache = new CachedEntDB(durable);
    const heard: boolean[] = [];
    cache.subscribe(() => {
      heard.push(applyStarted > 0);
    });

    const op = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0);
    const p = cache.apply([op]);
    await waitNotifies(heard, 1);
    expect(applyStarted).toBe(1);
    expect(heard[0]).toBe(true);

    releaseApply();
    await p;
  });

  // Counterpart: with the flag off, mem and notify wait on durable.apply.
  test("optimistic: false notifies only after durable.apply", async () => {
    const durable = new EntDBMemory();
    let releaseApply = () => {};
    const applyHold = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const origApply = durable.apply.bind(durable);
    durable.apply = async (ops) => {
      await applyHold;
      return origApply(ops);
    };
    const cache = new CachedEntDB(durable, undefined, { optimistic: false });
    await cache.getEntities({ type: "note" });
    const notifies: string[][] = [];
    cache.subscribe((types) => notifies.push([...types]));

    const op = await mutateOp({ n: 1 }, "note", new Date(1000), 0, 0);
    const p = cache.apply([op]);
    expect(notifies.length).toBe(0);
    const [before] = await cache.getEntities({ type: "note" });
    expect(before).toHaveLength(0);

    releaseApply();
    await p;
    expect(notifies.length).toBeGreaterThanOrEqual(1);
    expect(notifies[0]).toContain("note");
    const [after] = await cache.getEntities({ type: "note" });
    expect(after).toHaveLength(1);
  });

  test("concurrent warm list reads all see mem", async () => {
    const durable = new EntDBMemory();
    const cache = new CachedEntDB(durable);
    const ops = await Promise.all([
      mutateOp({ n: 1 }, "item", new Date(1000), 0, 0, 1),
      mutateOp({ n: 2 }, "item", new Date(1000), 0, 0, 2),
      mutateOp({ n: 3 }, "item", new Date(1000), 0, 0, 3),
    ]);
    await durable.apply(ops);

    // First call warms; remaining should hit mem without serializing on durable.
    await cache.getEntities({ type: "item" });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => cache.getEntities({ type: "item" })),
    );
    for (const [ents, st] of results) {
      expect(st).toBe(Status.Success);
      expect(ents).toHaveLength(3);
    }
  });
});
