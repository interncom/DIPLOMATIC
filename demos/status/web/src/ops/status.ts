import { type IOp, Verb } from "@interncom/diplomatic";
import { load, store } from "../models/status";

export interface IStatusOp extends IOp {
  type: "status";
  ver: 0;
  body: string;
}

export function isStatusOp(op: IOp): op is IStatusOp {
  return op.type === "status" && typeof op.body === "string";
}

export async function apply(op: IStatusOp) {
  const curr = load();
  if (!curr?.updatedAt || op.ts > curr.updatedAt) {
    const status = op.body;
    store({ status, updatedAt: op.ts });
  }
}

export function genOp(status: string): IOp {
  const op: IOp = {
    ts: new Date().toISOString(),
    type: "status",
    verb: Verb.UPSERT,
    ver: 0,
    body: status,
  };
  return op;
}
