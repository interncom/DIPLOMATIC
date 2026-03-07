// ValStat is a return value paired with a status code (for Go-style errors).

import { Status } from "./consts.ts";

export type StatusOK = Status.Success;
export type StatusNOK = Exclude<Status, Status.Success>;

export type ValStat<T> = [T, StatusOK] | [undefined, StatusNOK];

export function ok<T>(val: T): ValStat<T> {
  return [val, Status.Success];
}

export function err<T>(stat: StatusNOK): ValStat<T> {
  return [undefined, stat];
}
