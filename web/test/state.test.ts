import { beforeEach, describe, expect, test, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import { msgToOp, StateManager } from "../src/state";
import { Status } from "../src/shared/consts";
import { IMessage, IDeleteOp, IMutateOp, isMutateOp } from "../src/shared/types";

describe("msgToOp", () => {
  test("returns IDeleteOp when bod is undefined", () => {
    const msg: IMessage = {
      eid: new Uint8Array(16).fill(1),
      off: 100,
      ctr: 5,
      len: 0,
      // bod: undefined (implicit)
    };

    const [op, status] = msgToOp(msg);

    expect(status).toBe(Status.Success);
    expect(isMutateOp(op)).toBe(false);
    expect((op as IDeleteOp).off).toBe(100);
    expect((op as IDeleteOp).ctr).toBe(5);
    expect((op as IDeleteOp).eid).toEqual(msg.eid);
  });

  test("returns IDeleteOp when bod is empty buffer", () => {
    const msg: IMessage = {
      eid: new Uint8Array(16).fill(1),
      off: 100,
      ctr: 5,
      len: 0,
      bod: new Uint8Array(0),
    };

    const [op, status] = msgToOp(msg);

    expect(status).toBe(Status.Success);
    expect(isMutateOp(op)).toBe(false);
    expect((op as IDeleteOp).off).toBe(100);
    expect((op as IDeleteOp).ctr).toBe(5);
    expect((op as IDeleteOp).eid).toEqual(msg.eid);
  });

  test("returns IMutateOp when bod is valid msgpack", () => {
    const msgEntBody = {
      type: "testEntity",
      body: { key: "value" },
    };
    const bod = encode(msgEntBody);

    const msg: IMessage = {
      eid: new Uint8Array(16).fill(2),
      off: 200,
      ctr: 10,
      len: bod.length,
      bod,
    };

    const [op, status] = msgToOp(msg);

    expect(status).toBe(Status.Success);
    expect(isMutateOp(op)).toBe(true);
    const mutateOp = op as IMutateOp;
    expect(mutateOp.off).toBe(200);
    expect(mutateOp.ctr).toBe(10);
    expect(mutateOp.eid).toEqual(msg.eid);
    expect(mutateOp.type).toBe("testEntity");
    expect(mutateOp.body).toEqual({ key: "value" });
  });

  test("returns InvalidMessage when bod is invalid msgpack", () => {
    const msg: IMessage = {
      eid: new Uint8Array(16).fill(3),
      off: 300,
      ctr: 15,
      len: 1,
      bod: new Uint8Array([0xff]), // Invalid msgpack
    };

    const [op, status] = msgToOp(msg);

    expect(status).toBe(Status.InvalidMessage);
  });
});

describe("StateManager.apply", () => {
  let stateManager: StateManager;

  beforeEach(() => {
    const applier = vi.fn().mockImplementation((ops) => ({
      stats: ops.map(() => Status.Success),
      types: new Set(
        ops.filter((op: { type?: string }) => op.type).map((
          op: { type: string },
        ) => op.type),
      ),
    }));
    const clear = vi.fn().mockResolvedValue(Status.Success);
    stateManager = new StateManager(applier, clear);
  });

  test("emits events for successful mutate ops", async () => {
    const heard: string[] = [];
    stateManager.on("testEntity", () => {
      heard.push("testEntity");
    });

    const msgEntBody = {
      type: "testEntity",
      body: { key: "value" },
    };
    const bod = encode(msgEntBody);

    const msg: IMessage = {
      eid: new Uint8Array(16).fill(4),
      off: 400,
      ctr: 20,
      len: bod.length,
      bod,
    };

    const results = await stateManager.apply([msg]);

    expect(results).toEqual([Status.Success]);
    expect(heard).toContain("testEntity");
  });

  test("does not emit events for successful delete ops", async () => {
    const heard: string[] = [];
    // Subscribe to a type; deletes with no type should not fire it.
    stateManager.on("testEntity", () => {
      heard.push("testEntity");
    });

    const msg: IMessage = {
      eid: new Uint8Array(16).fill(5),
      off: 500,
      ctr: 25,
      len: 0,
      // bod: undefined
    };

    const results = await stateManager.apply([msg]);

    expect(results).toEqual([Status.Success]);
    expect(heard).toEqual([]);
  });

  test("handles mixed delete and mutate ops", async () => {
    const heard: string[] = [];
    stateManager.on("anotherEntity", () => {
      heard.push("anotherEntity");
    });
    stateManager.on("testEntity", () => {
      heard.push("testEntity");
    });

    const deleteMsg: IMessage = {
      eid: new Uint8Array(16).fill(6),
      off: 600,
      ctr: 30,
      len: 0,
    };

    const msgEntBody = {
      type: "anotherEntity",
      body: { data: "test" },
    };
    const bod = encode(msgEntBody);
    const mutateMsg: IMessage = {
      eid: new Uint8Array(16).fill(7),
      off: 700,
      ctr: 35,
      len: bod.length,
      bod,
    };

    const results = await stateManager.apply([deleteMsg, mutateMsg]);

    expect(results).toEqual([Status.Success, Status.Success]);
    expect(heard).toContain("anotherEntity");
    expect(heard).not.toContain("testEntity");
  });
});

describe("StateManager.clear", () => {
  test("invokes clearer and notifies subscribed types", async () => {
    const clearer = vi.fn().mockResolvedValue(Status.Success);
    const applier = vi.fn().mockResolvedValue({
      stats: [],
      types: new Set<string>(),
    });
    const mgr = new StateManager(applier, clearer);
    const heard: string[] = [];
    mgr.on("todo", () => {
      heard.push("todo");
    });
    mgr.on("note", () => {
      heard.push("note");
    });

    const stat = await mgr.clear();

    expect(stat).toBe(Status.Success);
    expect(clearer).toHaveBeenCalledOnce();
    expect(heard.sort()).toEqual(["note", "todo"]);
  });

  test("does not notify when clearer fails", async () => {
    const clearer = vi.fn().mockResolvedValue(Status.DatabaseError);
    const applier = vi.fn().mockResolvedValue({
      stats: [],
      types: new Set<string>(),
    });
    const mgr = new StateManager(applier, clearer);
    let heard = 0;
    mgr.on("todo", () => {
      heard += 1;
    });

    const stat = await mgr.clear();

    expect(stat).toBe(Status.DatabaseError);
    expect(heard).toBe(0);
  });
});
