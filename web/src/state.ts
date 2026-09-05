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
  EntityID,
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
  return true;
}

/** Legacy msgpack bodies stored type in-band; prefer msg head typ. */
function typeFromBody(bod: unknown): string | undefined {
  if (bod === null || typeof bod !== "object") return undefined;
  if (!("type" in bod)) return undefined;
  const t = bod.type;
  if (typeof t !== "string") return undefined;
  return t;
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
  const headTyp = msg.typ ?? "";
  const type = headTyp.length > 0 ? headTyp : (typeFromBody(bodDec) ?? "");
  const op: IMutateOp = {
    off: msg.off,
    ctr: msg.ctr,
    eid: msg.eid,
    pid: bodDec.pid,
    tags: bodDec.tags,
    type,
    body: bodDec.body,
  };
  return ok(op);
}

type PeerIngestFn = (eids: Iterable<EntityID>) => Promise<void>;

// StateManager emits events named by the op type which has just been updated.
export class StateManager implements IStateManager {
  private emitter = new TypedEventEmitter<null>();
  private clearer: () => Promise<Status>;
  /** Worker / peer: eids successfully applied to durable EntDB. */
  private onDirtyEids: ((eids: EntityID[]) => void) | undefined;
  /**
   * When set (CachedEntDB), type events come from cache.subscribe (optimistic
   * mem patch + later reconcile). apply() must not emit after awaiting the
   * applier — that Promise settles only after durable IDB.
   */
  private cacheDriven: boolean;
  private peerIngest: PeerIngestFn | undefined;

  constructor(
    public applier: Applier,
    clearer: () => Promise<Status>,
    /**
     * Called with eids that successfully applied (e.g. worker posts dirty).
     */
    onDirtyEids?: (eids: EntityID[]) => void,
    opts?: {
      cacheDriven?: boolean;
      peerIngest?: PeerIngestFn;
    },
  ) {
    this.clearer = clearer;
    this.onDirtyEids = onDirtyEids;
    this.cacheDriven = opts?.cacheDriven ?? false;
    this.peerIngest = opts?.peerIngest;
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

    // CachedEntDB.apply patches mem and queues persist before this await.
    const { stats: applyStats, types, eids } = await this.applier(ops);

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

    // Non-cache: notify here (applier had no subscribe). Cache: notified
    // from CachedEntDB subscribe (microtask after mem patch); emitting
    // here would wait until durable IDB.
    if (!this.cacheDriven) {
      for (const type of types) {
        this.emitter.emit(type, null);
      }
    }
    if (eids.length > 0) {
      this.onDirtyEids?.(eids);
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

  /** Notify type subscribers without applying msgs. */
  notify = (types: Iterable<string>) => {
    for (const type of types) {
      this.emitter.emit(type, null);
    }
  };

  /**
   * Peer (e.g. sync worker) updated durable EntDB for these eids.
   * Cache pulls those rows; apps still hear type-level events via subscribe.
   */
  refresh = async (eids: Iterable<EntityID>) => {
    if (this.peerIngest) {
      await this.peerIngest(eids);
      return;
    }
    // No cache: cannot map eid→type cheaply; callers without cache should
    // not rely on granular dirty (tests / singleton notify broadly).
    void eids;
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
  refresh: async function (_eids): Promise<void> {
  },
  on: function (_type, _listener): void {
  },
  off: function (_type, _listener): void {
  },
};
