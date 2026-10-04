// Realm rows, the label stored on ents and messages, and the realm KDM index.

import { Status } from "../shared/consts";
import { err, ok, type ValStat } from "../shared/valstat";

const entRlmSymbol = Symbol("EntRlm");

/** Non-empty realm label on an ent or archived message. */
export type EntRlm = string & { readonly [entRlmSymbol]: true };

/** One realm. `index` is the current KDM counter; `prior` are older ones. */
export interface IRealm {
  label: string;
  index: number;
  /** Counters older than `index` whose bags may still exist. */
  prior?: number[];
}

/** Realm label for a row. The default realm ("" or missing) is omitted. */
export function realmLabel(raw: unknown): EntRlm | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw as EntRlm;
}

/** Drops `rlm` when this row is in the default realm. */
export function omitDefaultRealm<T extends { rlm?: EntRlm | string }>(
  row: T,
): T {
  if (row.rlm !== undefined && row.rlm !== "") return row;
  if (row.rlm === undefined) return row;
  const next = { ...row };
  delete next.rlm;
  return next;
}

function isIndex(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

// Reads a realm row. Undefined when the value is not a realm.
export function decodeRealm(raw: unknown): IRealm | undefined {
  if (!isRec(raw) || typeof raw.label !== "string") return undefined;
  if (!isIndex(raw.index)) return undefined;
  const realm: IRealm = { label: raw.label, index: raw.index };
  if (raw.prior === undefined) return realm;
  if (!Array.isArray(raw.prior)) return undefined;
  const prior: number[] = [];
  for (const n of raw.prior) {
    if (!isIndex(n)) return undefined;
    prior.push(n);
  }
  if (prior.length > 0) realm.prior = prior;
  return realm;
}

// Sets the current index. A higher index appends the previous one to prior.
// The same index keeps prior. A lower index is InvalidParam.
export function advanceRealm(
  label: string,
  prev: IRealm | undefined,
  index: number,
): ValStat<IRealm> {
  if (typeof label !== "string" || !isIndex(index)) {
    return err(Status.InvalidParam);
  }
  if (prev !== undefined && index < prev.index) return err(Status.InvalidParam);
  const prior = prev?.prior !== undefined ? prev.prior.slice() : undefined;
  if (prev !== undefined && index > prev.index) {
    const nextPrior = prior !== undefined ? prior : [];
    nextPrior.push(prev.index);
    return ok({ label, index, prior: nextPrior });
  }
  return ok({ label, index, ...(prior !== undefined ? { prior } : {}) });
}

/** Realm counters for one account. The store is that account. */
export interface IRealmStore {
  list(): Promise<IRealm[]>;
  /** One realm, or undefined when this account has no row for the label. */
  get(label: string): Promise<IRealm | undefined>;
  /**
   * Set the current index.
   * A higher index keeps the previous one in `prior`.
   */
  put(label: string, index: number): Promise<Status>;
  wipe(): Promise<void>;
}
