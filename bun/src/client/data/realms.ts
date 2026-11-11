// Realm counters in the protocol SQLite file.

import type { Database } from "bun:sqlite";
import { Status } from "../../../../web/src/shared/consts.ts";
import { err, ok, type ValStat } from "../../../../web/src/shared/valstat.ts";
import {
  advanceRealm,
  decodeRealm,
  type IRealm,
  type IRealmStore,
} from "../../../../web/src/stores/realm.ts";
import { num, row, rows, run, str } from "../sql.ts";

// priorOf reads older indexes stored as JSON.
// Absent or empty is ok(undefined). Corrupt JSON is DatabaseError.
function priorOf(raw: string | undefined): ValStat<number[] | undefined> {
  if (raw === undefined) return ok(undefined);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(Status.DatabaseError);
  }
  if (!Array.isArray(parsed)) return err(Status.DatabaseError);
  const prior: number[] = [];
  for (const n of parsed) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      return err(Status.DatabaseError);
    }
    prior.push(n);
  }
  return ok(prior.length > 0 ? prior : undefined);
}

// realmFrom rebuilds one realm row. A corrupt row is DatabaseError.
function realmFrom(item: Record<string, unknown>): ValStat<IRealm> {
  const label = str(item, "label");
  const index = num(item, "idx");
  if (label === undefined || index === undefined) {
    return err(Status.DatabaseError);
  }
  const priorRaw = item.prior;
  let prior: number[] | undefined;
  if (typeof priorRaw === "string") {
    const [parsed, st] = priorOf(priorRaw);
    if (st !== Status.Success) return err(st);
    prior = parsed;
  } else if (priorRaw !== null && priorRaw !== undefined) {
    return err(Status.DatabaseError);
  }
  const realm = decodeRealm({
    label,
    index,
    ...(prior !== undefined ? { prior } : {}),
  });
  if (realm === undefined) return err(Status.DatabaseError);
  return ok(realm);
}

export class SqlRealms implements IRealmStore {
  constructor(private db: Database) {}

  async list(): Promise<IRealm[]> {
    const out: IRealm[] = [];
    for (const item of rows(this.db, "SELECT label, idx, prior FROM realms")) {
      const [realm, st] = realmFrom(item);
      if (st !== Status.Success) continue;
      out.push(realm);
    }
    return out;
  }

  async get(label: string): Promise<IRealm | undefined> {
    const item = row(
      this.db,
      "SELECT label, idx, prior FROM realms WHERE label = ?",
      label,
    );
    if (item === undefined) return undefined;
    const [realm, st] = realmFrom(item);
    if (st !== Status.Success) return undefined;
    return realm;
  }

  // put sets the current index. A higher index keeps the previous one in prior.
  async put(label: string, index: number): Promise<Status> {
    try {
      let status: Status = Status.Success;
      this.db.transaction(() => {
        const [cur, cst] = this.#get(label);
        if (cst !== Status.Success) {
          status = cst;
          return;
        }
        const [next, st] = advanceRealm(label, cur, index);
        if (st !== Status.Success) {
          status = st;
          return;
        }
        const prior = next.prior !== undefined && next.prior.length > 0
          ? JSON.stringify(next.prior)
          : null;
        run(
          this.db,
          `INSERT INTO realms (label, idx, prior) VALUES (?, ?, ?)
           ON CONFLICT(label) DO UPDATE SET
             idx = excluded.idx, prior = excluded.prior`,
          next.label,
          next.index,
          prior,
        );
      })();
      return status;
    } catch {
      return Status.DatabaseError;
    }
  }

  async wipe() {
    run(this.db, "DELETE FROM realms");
  }

  // #get reads one realm. A missing row is ok(undefined).
  #get(label: string): ValStat<IRealm | undefined> {
    const item = row(
      this.db,
      "SELECT label, idx, prior FROM realms WHERE label = ?",
      label,
    );
    if (item === undefined) return ok(undefined);
    return realmFrom(item);
  }
}
