import type { IOp } from "../../shared/types";
import * as Status from "./ops/status";
import type { IStatusOp } from "./ops/status";

// Applier MUST transactionally ignore deltas upserting entities modified after the delta timestamp.
export async function apply(op: IOp) {
  const typeApplier = appliers[op.type];
  if (typeApplier?.typeChecks(op)) {
    return typeApplier.applier(op);
  }
  // Unhandled operation.
  // TODO: log or throw.
  return;
}

interface IApplier<T extends IOp> {
  typeChecks: (op: IOp) => op is T;
  applier: (op: T) => Promise<void>;
}
const appliers: Record<string, IApplier<IStatusOp>> = {
  "status": {
    typeChecks: Status.isStatusOp,
    applier: Status.apply,
  }
};
