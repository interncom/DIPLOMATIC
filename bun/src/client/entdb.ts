// EntDB in one ents-<acct>.sqlite file. Bodies stay inline in the row.

import type { Database } from "bun:sqlite";
import { btoh } from "../../../web/src/shared/binary.ts";
import { checksumEntRevs } from "../../../web/src/shared/checksum.ts";
import { Status } from "../../../web/src/shared/consts.ts";
import type {
  EntityID,
  Hash,
  ICrypto,
  IOp,
} from "../../../web/src/shared/types.ts";
import { err, ok, type ValStat } from "../../../web/src/shared/valstat.ts";
import {
  applyOp,
  dateMatches,
  type DateSpec,
  dateSpecMayMatch,
  type EntitiesQuery,
  type IEntDB,
  type IEntity,
  type IEntRow,
  isLiveEnt,
  revFromEntity,
  tagMatches,
  type TagSpec,
  tagSpecMayMatch,
  typesChanged,
} from "../../../web/src/entdb/entdb.ts";
import { realmLabel } from "../../../web/src/stores/realm.ts";
import { readEID } from "./brand.ts";
import { blob, num, row, rows, run, str } from "./sql.ts";

const schema = `
CREATE TABLE IF NOT EXISTS ents (
  eid BLOB PRIMARY KEY,
  typ TEXT,
  pid BLOB,
  tags TEXT,
  bod BLOB,
  crd INTEGER,
  upd INTEGER NOT NULL,
  ctr INTEGER NOT NULL,
  rlm TEXT
);
CREATE TABLE IF NOT EXISTS ent_tags (
  tag TEXT NOT NULL,
  eid BLOB NOT NULL,
  PRIMARY KEY (tag, eid)
);
CREATE INDEX IF NOT EXISTS ents_typ_upd ON ents(typ, upd);
CREATE INDEX IF NOT EXISTS ents_typ_pid ON ents(typ, pid);
`;

const cols = "eid, typ, pid, tags, bod, crd, upd, ctr, rlm";

// asEnt reattaches a stored byte body onto the caller's T.
function asEnt<T>(row: IEntity<Uint8Array>): IEntity<T> {
  return row as unknown as IEntity<T>;
}

function readTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const tags: string[] = [];
  for (const t of parsed) {
    if (typeof t === "string" && t.length > 0) tags.push(t);
  }
  return tags.length > 0 ? tags : undefined;
}

// readRow rebuilds a live ent or a tombstone. Undefined when eid is not canonical.
function readRow(
  item: Record<string, unknown>,
): IEntRow<Uint8Array> | undefined {
  const eidBytes = blob(item, "eid");
  if (eidBytes === undefined) return undefined;
  const eid = readEID(eidBytes);
  if (eid === undefined) return undefined;
  const upd = num(item, "upd");
  const ctr = num(item, "ctr");
  if (upd === undefined || ctr === undefined) return undefined;
  const typRaw = item.typ;
  if (typRaw === null || typRaw === undefined) {
    return { eid, updatedAt: new Date(upd), ctr };
  }
  if (typeof typRaw !== "string") return undefined;
  const pidBytes = blob(item, "pid");
  let pid: EntityID | undefined;
  if (pidBytes !== undefined) {
    pid = readEID(pidBytes);
    if (pid === undefined) return undefined;
  }
  const tags = readTags(str(item, "tags"));
  const rlm = realmLabel(str(item, "rlm"));
  const crd = num(item, "crd");
  const ent: IEntity<Uint8Array> = {
    eid,
    type: typRaw,
    body: blob(item, "bod") ?? new Uint8Array(),
    createdAt: new Date(crd ?? upd),
    updatedAt: new Date(upd),
    ctr,
  };
  if (pid !== undefined) ent.pid = pid;
  if (tags !== undefined) ent.tags = tags;
  if (rlm !== undefined) ent.rlm = rlm;
  return ent;
}

function prefixHi(prefix: string): string | undefined {
  const chars = Array.from(prefix);
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    if (ch === undefined) continue;
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp >= 0x10ffff) continue;
    chars[i] = String.fromCodePoint(cp + 1);
    return chars.slice(0, i + 1).join("");
  }
  return undefined;
}

export class EntSqlite implements IEntDB {
  constructor(private db: Database) {
    this.db.exec(schema);
  }

  // close releases this ents file.
  close() {
    this.db.close();
  }

  // apply runs ops in order inside one transaction, so a later op sees the earlier write.
  apply = async (ops: IOp[]) => {
    const types = new Set<string>();
    const eids: EntityID[] = [];
    const stats: Status[] = [];
    if (ops.length === 0) return { stats, types, eids };
    try {
      this.db.transaction(() => {
        for (const op of ops) {
          const curr = this.#row(op.eid);
          const [next, st] = applyOp(curr, op);
          if (st !== Status.Success || next === undefined) {
            stats.push(st === Status.Success ? Status.InternalError : st);
            continue;
          }
          if (
            isLiveEnt(next) && next.body !== undefined &&
            next.body !== null &&
            !(next.body instanceof Uint8Array)
          ) {
            stats.push(Status.InvalidParam);
            continue;
          }
          for (const t of typesChanged(curr, next)) types.add(t);
          this.#put(next);
          eids.push(op.eid);
          stats.push(Status.Success);
        }
      })();
    } catch {
      return {
        stats: ops.map(() => Status.DatabaseError),
        types: new Set<string>(),
        eids: [],
      };
    }
    return { stats, types, eids };
  };

  // clear drops every ent and tag. Tombstones go too.
  async clear(): Promise<Status> {
    try {
      this.db.transaction(() => {
        this.db.exec("DELETE FROM ent_tags");
        this.db.exec("DELETE FROM ents");
      })();
      return Status.Success;
    } catch {
      return Status.DatabaseError;
    }
  }

  async getEnt<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntity<T> | undefined>> {
    const [got, st] = await this.getRow<T>(eid);
    if (st !== Status.Success) return err(st);
    if (got === undefined || !isLiveEnt(got)) return ok(undefined);
    return ok(got);
  }

  async getRow<T>(
    eid: EntityID,
  ): Promise<ValStat<IEntRow<T> | undefined>> {
    try {
      const got = this.#row(eid);
      if (got === undefined || !isLiveEnt(got)) return ok(got);
      return ok(asEnt(got));
    } catch {
      return err(Status.DatabaseError);
    }
  }

  async getEntities<T>(
    query: EntitiesQuery,
  ): Promise<ValStat<IEntity<T>[]>> {
    try {
      const [ents, st] = this.#query(query);
      if (st !== Status.Success) return err(st);
      return ok((ents ?? []).map((ent) => asEnt<T>(ent)));
    } catch {
      return err(Status.DatabaseError);
    }
  }

  async countEntities({ type }: { type: string }): Promise<ValStat<number>> {
    try {
      const item = row(
        this.db,
        "SELECT COUNT(*) AS n FROM ents WHERE typ = ?",
        type,
      );
      return ok(item === undefined ? 0 : num(item, "n") ?? 0);
    } catch {
      return err(Status.DatabaseError);
    }
  }

  // checksum covers live ents and tombstones.
  async checksum(crypto: ICrypto): Promise<ValStat<Hash>> {
    try {
      const revs = [];
      for (const item of rows(this.db, `SELECT ${cols} FROM ents`)) {
        const got = readRow(item);
        if (got === undefined) return err(Status.DatabaseError);
        revs.push(revFromEntity(got));
      }
      return checksumEntRevs(revs, crypto);
    } catch {
      return err(Status.DatabaseError);
    }
  }

  #row(eid: EntityID): IEntRow<Uint8Array> | undefined {
    const item = row(
      this.db,
      `SELECT ${cols} FROM ents WHERE eid = ?`,
      eid,
    );
    if (item === undefined) return undefined;
    return readRow(item);
  }

  #put(got: IEntRow) {
    if (!isLiveEnt(got)) {
      run(
        this.db,
        `INSERT INTO ents (eid, typ, pid, tags, bod, crd, upd, ctr, rlm)
         VALUES (?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
         ON CONFLICT(eid) DO UPDATE SET
           typ = NULL, pid = NULL, tags = NULL, bod = NULL,
           crd = NULL, upd = excluded.upd, ctr = excluded.ctr, rlm = NULL`,
        got.eid,
        got.updatedAt.getTime(),
        got.ctr,
      );
      run(this.db, "DELETE FROM ent_tags WHERE eid = ?", got.eid);
      return;
    }
    const rlm = realmLabel(got.rlm);
    const body = got.body instanceof Uint8Array ? got.body : null;
    run(
      this.db,
      `INSERT INTO ents (eid, typ, pid, tags, bod, crd, upd, ctr, rlm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(eid) DO UPDATE SET
         typ = excluded.typ, pid = excluded.pid, tags = excluded.tags,
         bod = excluded.bod, crd = excluded.crd, upd = excluded.upd,
         ctr = excluded.ctr, rlm = excluded.rlm`,
      got.eid,
      got.type,
      got.pid ?? null,
      got.tags !== undefined ? JSON.stringify(got.tags) : null,
      body,
      got.createdAt.getTime(),
      got.updatedAt.getTime(),
      got.ctr,
      rlm ?? null,
    );
    run(this.db, "DELETE FROM ent_tags WHERE eid = ?", got.eid);
    if (got.tags === undefined) return;
    for (const tag of got.tags) {
      run(
        this.db,
        "INSERT INTO ent_tags (tag, eid) VALUES (?, ?)",
        tag,
        got.eid,
      );
    }
  }

  // #query lists live ents for one query.
  #query(query: EntitiesQuery): ValStat<IEntity<Uint8Array>[]> {
    const type = query.type;
    if ("tag" in query) return this.#byTag(type, query.tag);
    if ("updatedAt" in query) return this.#byDate(type, query.updatedAt);
    if ("pid" in query) {
      return ok(live(
        rows(
          this.db,
          `SELECT ${cols} FROM ents WHERE typ = ? AND pid = ?`,
          type,
          query.pid,
        ),
      ));
    }
    return ok(live(
      rows(this.db, `SELECT ${cols} FROM ents WHERE typ = ?`, type),
    ));
  }

  #byTag(type: string, spec: TagSpec): ValStat<IEntity<Uint8Array>[]> {
    const [may, st] = tagSpecMayMatch(spec);
    if (st !== Status.Success) return err(st);
    if (!may) return ok([]);
    let sql =
      `SELECT e.eid, e.typ, e.pid, e.tags, e.bod, e.crd, e.upd, e.ctr, e.rlm, t.tag AS hit
       FROM ents e JOIN ent_tags t ON t.eid = e.eid
       WHERE e.typ = ?`;
    const args: (string | number)[] = [type];
    if (typeof spec === "string") {
      sql += " AND t.tag = ?";
      args.push(spec);
    } else if ("range" in spec) {
      sql += " AND t.tag >= ? AND t.tag <= ?";
      args.push(spec.range.start, spec.range.end);
    } else {
      sql += " AND t.tag >= ?";
      args.push(spec.prefix);
      const hi = prefixHi(spec.prefix);
      if (hi !== undefined) {
        sql += " AND t.tag < ?";
        args.push(hi);
      }
    }
    const seen = new Set<string>();
    const out: IEntity<Uint8Array>[] = [];
    for (const item of rows(this.db, sql, ...args)) {
      const hit = str(item, "hit");
      if (hit === undefined || !tagMatches(hit, spec)) continue;
      const ent = readRow(item);
      if (ent === undefined || !isLiveEnt(ent)) continue;
      const key = btoh(ent.eid);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ent);
    }
    return ok(out);
  }

  #byDate(type: string, spec: DateSpec): ValStat<IEntity<Uint8Array>[]> {
    const [may, st] = dateSpecMayMatch(spec);
    if (st !== Status.Success) return err(st);
    if (!may) return ok([]);
    let items: Record<string, unknown>[];
    if (spec instanceof Date) {
      items = rows(
        this.db,
        `SELECT ${cols} FROM ents WHERE typ = ? AND upd = ?`,
        type,
        spec.getTime(),
      );
    } else {
      items = rows(
        this.db,
        `SELECT ${cols} FROM ents WHERE typ = ? AND upd >= ? AND upd <= ?`,
        type,
        spec.range.start.getTime(),
        spec.range.end.getTime(),
      );
    }
    const out: IEntity<Uint8Array>[] = [];
    for (const item of items) {
      const ent = readRow(item);
      if (ent === undefined || !isLiveEnt(ent)) continue;
      if (!dateMatches(ent.updatedAt, spec)) continue;
      out.push(ent);
    }
    return ok(out);
  }
}

function live(items: Record<string, unknown>[]): IEntity<Uint8Array>[] {
  const out: IEntity<Uint8Array>[] = [];
  for (const item of items) {
    const ent = readRow(item);
    if (ent !== undefined && isLiveEnt(ent)) out.push(ent);
  }
  return out;
}
