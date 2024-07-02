import { EventEmitter } from "./eventEmitter";
import type { Applier } from "./types";
import type { IOp } from "./shared/types";

export class StateManager {
  emitter: EventEmitter = new EventEmitter();
  applier: Applier;
  clear: () => Promise<void>;
  constructor(applier: Applier, clear: () => Promise<void>) {
    this.applier = applier;
    this.clear = clear;
  }

  apply = async (op: IOp) => {
    await this.applier(op);
    this.emitter.emit(op.type);
  }

  on = (opType: string, listener: () => void) => {
    this.emitter.on(opType, listener);
  }

  off = (opType: string, listener: () => void) => {
    this.emitter.off(opType, listener);
  }
}

interface IApplier<T extends IOp> {
  check: (op: IOp) => op is T;
  apply: (op: T) => Promise<void>;
}

type Appliers<M> = {
  [K in keyof M]: M[K] extends IOp ? IApplier<M[K]> : never;
}

// opMapApplier generates an operation applier from a record
// mapping from op type to op IApplier. This is a convenience
// function to organize handling of multiple op types.
//
// Example usage:
//
// export interface IStatusOp extends IOp {
//   type: "status";
//   body: string;
// }
// const applier = opMapApplier<{ status: IStatusOp }>({
//   "status": {
//     check: (op: IOp): op is IStatusOp => {
//       return op.type === "status" && typeof op.body === "string";
//     },
//     apply: async (op: IStatusOp) => {
//       const curr = statusStore.load();
//       if (!curr?.updatedAt || op.ts > curr.updatedAt) {
//         const status = op.body;
//         statusStore.store({ status, updatedAt: op.ts });
//       }
//     }
//   }
// });
export function opMapApplier<M>(appliers: Appliers<M>) {
  return async (op: IOp) => {
    const applier = appliers[op.type as keyof M];
    if (applier?.check(op)) {
      await applier.apply(op);
    }
  }
}
