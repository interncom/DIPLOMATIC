import { decode } from "@msgpack/msgpack";
import { TypedEventEmitter } from "./events";
import { Status } from "./shared/consts";
import { IMessage, IMsgEntBody, IOp } from "./shared/types";
import { err, ok, ValStat } from "./shared/valstat";
import type { Applier, IStateManager } from "./types";

export function isMsgEntBody(bodDec: unknown): bodDec is IMsgEntBody {
  if (!bodDec) {
    return false;
  }
  if (typeof bodDec !== "object") {
    return false;
  }
  if ("body" in bodDec === false) {
    return false;
  }
  if ("type" in bodDec === false) {
    return false;
  }
  return true;
}

export function msgToOp(msg: IMessage): ValStat<IOp> {
  // If an IMessage represents an entity update (i.e. it's used in EntDB),
  // then the bod of the IMessage must be an msgpack-encoded IMsgEntBod.
  if (!msg.bod) {
    return err(Status.MissingBody);
  }
  const bodDec = decode(msg.bod);
  if (isMsgEntBody(bodDec) === false) {
    console.warn(`msg body invalid`, bodDec)
    return err(Status.InvalidMessage);
  }
  const op: IOp = {
    off: msg.off,
    ctr: msg.ctr,
    eid: msg.eid,
    gid: bodDec.gid,
    pid: bodDec.pid,
    type: bodDec.type,
    body: bodDec.body,
  };
  return ok(op);
}

// StateManager emits events named by the op type which has just been updated.
export class StateManager implements IStateManager {
  private emitter = new TypedEventEmitter<null>();
  constructor(
    public applier: Applier,
    public clear: () => Promise<Status>,
  ) { }

  apply = async (msgs: IMessage[]) => {
    const ops: IOp[] = [];
    const parseStats: Status[] = [];
    for (const msg of msgs) {
      const [op, statParse] = msgToOp(msg);
      parseStats.push(statParse);
      if (statParse !== Status.Success) {
        continue;
      }
      ops.push(op);
    }

    const applyStats = await Promise.all(ops.map(this.applier.bind(this)));
    const results: Status[] = [];
    const successfulTypes = new Set<string>();
    for (let i = 0; i < msgs.length; i++) {
      const parseStat = parseStats[i];
      const applyStat = applyStats[i];
      if (parseStat !== Status.Success) {
        results.push(parseStat);
      } else {
        if (applyStat !== Status.Success) {
          results.push(applyStat);
          continue;
        }
        const [op, statOp] = msgToOp(msgs[i]);
        if (statOp !== Status.Success) {
          results.push(applyStat);
          continue;
        }
        successfulTypes.add(op.type);
        results.push(Status.Success);
      }
    }
    for (const type of successfulTypes) {
      this.emitter.emit(type, null);
    }
    return results;
  };

  on = (opType: string, listener: () => void) => {
    this.emitter.addEventListener(opType, listener);
  };

  off = (opType: string, listener: () => void) => {
    this.emitter.removeEventListener(opType, listener);
  };
}

// nullStateManager is a helper for initializing
export const nullStateManager: IStateManager = {
  apply: async function(msgs: IMessage[]) {
    return msgs.map(() => Status.Success);
  },
  on: function(type, listener): void {
  },
  off: function(type, listener): void {
  },
};
