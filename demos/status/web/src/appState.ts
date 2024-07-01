import { StateManager, type IOp } from "@interncom/diplomatic";
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

export const stateMgr = new StateManager(async (op) => {
  const apl = appliers[op.type];
  if (apl?.typeChecks(op)) {
    await apl.applier(op);
  }
})
