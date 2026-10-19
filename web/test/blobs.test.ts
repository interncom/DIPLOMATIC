// Blob msgs store the bytes as the ent body.

import { expect, test } from "vitest";
import { bytesEqual } from "../src/shared/binary";
import { blobTyp, mimeOf, openBlob } from "../src/shared/blobs";
import { MockClock } from "../src/shared/clock";
import { makeEID } from "../src/shared/codecs/eid";
import { Status } from "../src/shared/consts";
import type { IMessage, IStateManager } from "../src/shared/types";
import { isMutateOp } from "../src/shared/types";
import type { ValStat } from "../src/shared/valstat";
import { msgToOp } from "../src/state";
import { SyncClient } from "../src/client";
import libsodiumCrypto from "../src/crypto";
import type { IStoredMessage } from "../src/types";
import { applyOp, isLiveEnt } from "../src/entdb/entdb";
import { MemoryStore } from "../src/stores/memory/store";

function must<T>(vs: ValStat<T>): T {
  const [v, st] = vs;
  if (st !== Status.Success || v === undefined) {
    throw new Error(`status ${st}`);
  }
  return v;
}

function mockState(): IStateManager & { applied: IMessage[] } {
  const applied: IMessage[] = [];
  return {
    applied,
    async apply(msgs) {
      applied.push(...msgs);
      return msgs.map(() => Status.Success);
    },
    async clear() {
      return Status.Success;
    },
    notify() {},
    async refresh() {},
    on() {},
    off() {},
  };
}

function clientOf() {
  const state = mockState();
  const store = new MemoryStore(libsodiumCrypto);
  const client = new SyncClient(
    new MockClock(new Date(1_700_000_000_000)),
    state,
    store,
    () => {
      throw new Error("no transport");
    },
    libsodiumCrypto,
  );
  return { client, state };
}

async function bodOf(
  rows: IStoredMessage[],
  eid: Uint8Array,
  ctr: number,
): Promise<Uint8Array> {
  for (const row of rows) {
    if (row.head.ctr !== ctr) continue;
    if (!bytesEqual(row.head.eid, eid)) continue;
    if (row.body === undefined) continue;
    return row.body;
  }
  throw new Error("missing msg body");
}

function takeBody(body: unknown): Uint8Array {
  if (!(body instanceof Uint8Array)) throw new Error("body");
  return body;
}

test("blobTyp and mimeOf round-trip a mime", () => {
  expect(blobTyp("image/jpeg")).toBe("blob:image/jpeg");
  expect(mimeOf("blob:image/jpeg")).toBe("image/jpeg");
  expect(mimeOf("todo")).toBeUndefined();
  expect(mimeOf("blob:")).toBeUndefined();
});

test("openBlob rejects a truncated body", () => {
  const [, st] = openBlob(new Uint8Array([0xff]));
  expect(st).not.toBe(Status.Success);
});

test("insert rejects an empty mime", async () => {
  const { client } = clientOf();
  const [, st] = await client.insertBlob("", new Uint8Array([1]));
  expect(st).toBe(Status.InvalidParam);
  expect(await client.countMsgs()).toBe(0);
});

test("insert stores the bytes as the ent body", async () => {
  const { client, state } = clientOf();
  const pid = must(makeEID({
    id: new Uint8Array(8).fill(2),
    ts: new Date(1_700_000_000_000),
  }));
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const head = must(
    await client.insertBlob("image/jpeg", bytes, {
      tags: ["name:cat.jpg"],
      pid,
    }),
  );
  expect(head.typ).toBe("blob:image/jpeg");
  expect(head.len).toBeGreaterThan(bytes.length);

  const msg = state.applied[0];
  if (msg === undefined || msg.bod === undefined) throw new Error("no msg");
  const opened = must(openBlob(msg.bod));
  const raw = takeBody(opened.body);
  expect(bytesEqual(raw, bytes)).toBe(true);
  expect(raw.buffer).toBe(msg.bod.buffer);
  expect(opened.tags).toEqual(["name:cat.jpg"]);
  expect(bytesEqual(opened.pid ?? new Uint8Array(), pid)).toBe(true);

  const got = must(await client.readBlob(head.eid));
  expect(bytesEqual(got, bytes)).toBe(true);
  expect(got.buffer).not.toBe(msg.bod.buffer);

  const op = must(msgToOp(msg));
  if (!isMutateOp(op)) throw new Error("delete");
  expect(op.type).toBe("blob:image/jpeg");
  expect(bytesEqual(takeBody(op.body), bytes)).toBe(true);
  const row = must(applyOp(undefined, op));
  if (!isLiveEnt(row)) throw new Error("tomb");
  expect(bytesEqual(takeBody(row.body), bytes)).toBe(true);
  expect(row.type).toBe("blob:image/jpeg");
  expect(row.tags).toEqual(["name:cat.jpg"]);
});

test("empty bytes are a blob, not a delete", async () => {
  const { client, state } = clientOf();
  const head = must(await client.insertBlob("text/plain", new Uint8Array()));
  const got = must(await client.readBlob(head.eid));
  expect(got.length).toBe(0);
  const msg = state.applied[0];
  if (msg === undefined) throw new Error("no msg");
  const op = must(msgToOp(msg));
  expect(isMutateOp(op)).toBe(true);
  if (!isMutateOp(op)) return;
  expect(op.body).toBeUndefined();
});

test("update keeps omitted tags and replaces bytes", async () => {
  const { client } = clientOf();
  const head = must(
    await client.insertBlob("image/png", new Uint8Array([1]), {
      tags: ["name:a.png"],
    }),
  );
  const next = new Uint8Array([2, 3]);
  const updated = must(await client.updateBlob(head.eid, next));
  expect(updated.typ).toBe("blob:image/png");
  const got = must(await client.readBlob(head.eid));
  expect(bytesEqual(got, next)).toBe(true);
  const stored = must(openBlob(
    await bodOf(await client.listMsgs(), head.eid, updated.ctr),
  ));
  expect(bytesEqual(takeBody(stored.body), next)).toBe(true);
  expect(stored.tags).toEqual(["name:a.png"]);
});

test("update replaces fields that are present", async () => {
  const { client, state } = clientOf();
  const head = must(
    await client.insertBlob("image/png", new Uint8Array([1]), {
      tags: ["name:a.png"],
    }),
  );
  const next = new Uint8Array([4]);
  const updated = must(
    await client.updateBlob(head.eid, next, {
      tags: [],
      mime: "image/webp",
    }),
  );
  expect(updated.typ).toBe("blob:image/webp");
  const stored = must(openBlob(
    await bodOf(await client.listMsgs(), head.eid, updated.ctr),
  ));
  expect(stored.tags).toBeUndefined();
  expect(bytesEqual(takeBody(stored.body), next)).toBe(true);
  const msg = state.applied[1];
  if (msg === undefined) throw new Error("no msg");
  const row = must(applyOp(undefined, must(msgToOp(msg))));
  if (!isLiveEnt(row)) throw new Error("tomb");
  expect(row.tags).toBeUndefined();
  expect(bytesEqual(takeBody(row.body), next)).toBe(true);
  expect(row.type).toBe("blob:image/webp");
});

test("update of a prev msg with no blob mime is InvalidParam", async () => {
  const { client } = clientOf();
  const todo = must(await client.insert({
    type: "todo",
    body: new Uint8Array([1]),
  }));
  const [, stTodo] = await client.updateBlob(todo.eid, new Uint8Array([2]));
  expect(stTodo).toBe(Status.InvalidParam);

  const empty = must(await client.insert({
    type: "blob:",
    body: new Uint8Array([1]),
  }));
  const [, stEmpty] = await client.updateBlob(empty.eid, new Uint8Array([2]));
  expect(stEmpty).toBe(Status.InvalidParam);
});

test("update of an unknown eid is NotFound", async () => {
  const { client } = clientOf();
  const eid = must(makeEID({
    id: new Uint8Array(8).fill(9),
    ts: new Date(0),
  }));
  const [, st] = await client.updateBlob(eid, new Uint8Array([1]));
  expect(st).toBe(Status.NotFound);
});

test("delete removes the readable bytes", async () => {
  const { client } = clientOf();
  const bytes = new Uint8Array([1, 2]);
  const head = must(await client.insertBlob("text/plain", bytes));
  must(await client.deleteBlob(head.eid));
  const [, st] = await client.readBlob(head.eid);
  expect(st).toBe(Status.NotFound);
  const [, stUp] = await client.updateBlob(head.eid, new Uint8Array([3]));
  expect(stUp).toBe(Status.NotFound);
  expect(await client.countMsgs()).toBe(2);
});
