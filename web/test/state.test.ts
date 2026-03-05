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
  let emittedEvents: string[];

  beforeEach(() => {
    emittedEvents = [];
    const applier = vi.fn().mockImplementation(ops => ops.map(() => Status.Success));
    const clear = vi.fn().mockResolvedValue(Status.Success);
    stateManager = new StateManager(applier, clear);
    // Spy on the private emitter's emit method
    const originalEmit = stateManager.emitter.emit;
    stateManager.emitter.emit = vi.fn((event: string, data: null) => {
      emittedEvents.push(event);
      return originalEmit.call(stateManager.emitter, event, data);
    });
  });

  test("emits events for successful mutate ops", async () => {
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
    expect(emittedEvents).toContain("testEntity");
  });

  test("does not emit events for successful delete ops", async () => {
    const msg: IMessage = {
      eid: new Uint8Array(16).fill(5),
      off: 500,
      ctr: 25,
      len: 0,
      // bod: undefined
    };

    const results = await stateManager.apply([msg]);

    expect(results).toEqual([Status.Success]);
    expect(emittedEvents).toEqual([]);
  });

  test("handles mixed delete and mutate ops", async () => {
    // Delete msg
    const deleteMsg: IMessage = {
      eid: new Uint8Array(16).fill(6),
      off: 600,
      ctr: 30,
      len: 0,
    };

    // Mutate msg
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
    expect(emittedEvents).toContain("anotherEntity");
    expect(emittedEvents).not.toContain("testEntity"); // Only the mutate one
  });
});