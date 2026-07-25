import { describe, expect, test } from "vitest";
import { encode } from "@msgpack/msgpack";
import { CachedEntDB } from "../src/entdb/cached";
import { EntDBMemory } from "../src/entdb/memory";
import { revFromEntity } from "../src/entdb/entdb";
import { msgToOp } from "../src/state";
import { Status } from "../src/shared/consts";
import { makeEID } from "../src/shared/codecs/eid";
import type { EntityID, IMessage, IOp } from "../src/shared/types";

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
  const bod = encode({ type, body });
  const msg: IMessage = { eid, off, ctr, len: bod.length, bod };
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
});
