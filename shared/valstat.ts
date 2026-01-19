// ValStat is a return value paired with a status code (for Go-style errors).
import { Status } from "./consts.ts";

export type StatusOK = Status.Success;
export type StatusNOK = Exclude<Status, Status.Success>;

export type ValStat<T> =
  | { val: T; status: StatusOK }
  | { val: undefined; status: StatusNOK };

export function ok<T>(val: T): ValStat<T> {
  return { val, status: Status.Success };
}

export function err<T>(stat: StatusNOK): ValStat<T> {
  return { val: undefined, status: stat };
}

// vs is a helper that returns a ValStat as a [Val, Stat] tuple.
export function vs<T>(valstat: ValStat<T>): [T, StatusOK] | [undefined, StatusNOK] {
  const { val, status } = valstat;
  if (status !== Status.Success) {
    return [undefined, status];
  }
  return [val, status];
}
