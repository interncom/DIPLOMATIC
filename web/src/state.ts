// This file implements a "state manager", which updates application state.
// It does so in response to DIPLOMATIC messages.
// When a message (msg) comes in which is more recent than the last one
// for a particular eid, that new message contains the new state of the
// application object ("ent" in EntDB) associated with that eid.
// StateManager delegates to a pluggable "applier" to do the updates.

import { decode } from "@msgpack/msgpack";
import { TypedEventEmitter } from "./shared/events";
import { Status } from "./shared/consts";
import {
  IDeleteOp,
  IMessage,
  IMsgEntBody,
  IMutateOp,
  IOp,
  IStateManager,
} from "./shared/types";
import { err, ok, ValStat } from "./shared/valstat";
import type { Applier } from "./types";

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
  if (!msg.bod || msg.bod.length === 0) {
    // Undefined or empty bod indicates a delete operation.
    const op: IDeleteOp = {
      off: msg.off,
      ctr: msg.ctr,
      eid: msg.eid,
    };
    return ok(op);
  }
  const bodDec = decode(msg.bod);
  if (isMsgEntBody(bodDec) === false) {
    console.warn(`msg body invalid`, bodDec);
    return err(Status.InvalidMessage);
  }
  const op: IMutateOp = {
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
  private clearer: () => Promise<Status>;
  private onTypes: ((types: Set<string>) => void) | undefined;

  constructor(
    public applier: Applier,
    clearer: () => Promise<Status>,
    /** Optional hook after a successful apply batch (e.g. worker dirty signal). */
    onTypes?: (types: Set<string>) => void,
  ) {
    this.clearer = clearer;
    this.onTypes = onTypes;
  }

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

    const { stats: applyStats, types } = await this.applier(ops);

    const results: Status[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const parseStat = parseStats[i];
      const applyStat = applyStats[i];
      if (parseStat !== Status.Success) {
        results.push(parseStat);
        continue;
      }
      if (applyStat !== Status.Success) {
        results.push(applyStat);
        continue;
      }
      results.push(Status.Success);
    }

    for (const type of types) {
      this.emitter.emit(type, null);
    }
    if (types.size > 0) {
      this.onTypes?.(types);
    }
    return results;
  };

  /** Clear application state and notify all type subscribers. */
  clear = async (): Promise<Status> => {
    const stat = await this.clearer();
    if (stat !== Status.Success) {
      return stat;
    }
    this.emitter.emitAll(null);
    return stat;
  };

  /** Notify type subscribers without applying msgs (shared-IDB peer updates). */
  notify = (types: Iterable<string>) => {
    for (const type of types) {
      this.emitter.emit(type, null);
    }
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
  apply: async function (msgs: IMessage[]) {
    return msgs.map(() => Status.Success);
  },
  clear: async function () {
    return Status.Success;
  },
  notify: function (_types): void {
  },
  on: function (_type, _listener): void {
  },
  off: function (_type, _listener): void {
  },
};
