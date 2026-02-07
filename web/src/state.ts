import { TypedEventEmitter } from "./events";
import type { Applier, IStateManager } from "./types";
import { Status } from "./shared/consts";
import { EntityID, GroupID, IMessage, IOp } from "./shared/types";
import { decode } from "@msgpack/msgpack";
import { err, ok, ValStat } from "./shared/valstat";

export interface IMsgEntBody<T = unknown> {
  gid?: GroupID;
  pid?: EntityID; // Parent entity ID. Not necessarily of same type.
  type: string;
  body: T;
}
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
    return err(Status.InvalidMessage);
  }
  const op = {
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

  apply = async (msg: IMessage) => {
    const [op, statParse] = msgToOp(msg);
    if (statParse !== Status.Success) {
      return statParse;
    }

    const statApply = await this.applier(op);
    if (statApply !== Status.Success) {
      // NOTE: this includes Status.NoChange, which is not an error.
      return statApply;
    }

    this.emitter.emit(op.type, null);
    return Status.Success;
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
  apply: async function(msg) {
    return Status.Success;
  },
  on: function(type, listener): void {
  },
  off: function(type, listener): void {
  },
};
