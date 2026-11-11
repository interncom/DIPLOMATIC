// SQLite open and row readers for the client stores.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";

// isRec means v is a plain object row.
export function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

// openDB opens path, creating it, with WAL and a busy wait.
export function openDB(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}

// ensureDir creates path and its parents.
export function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

// row reads one object, or undefined when the query misses.
export function row(
  db: Database,
  sql: string,
  ...args: SQLQueryBindings[]
): Record<string, unknown> | undefined {
  const raw: unknown = db.prepare(sql).get(...args);
  if (!isRec(raw)) return undefined;
  return raw;
}

// rows reads every object the query returns.
export function rows(
  db: Database,
  sql: string,
  ...args: SQLQueryBindings[]
): Record<string, unknown>[] {
  const raw: unknown = db.prepare(sql).all(...args);
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (isRec(item)) out.push(item);
  }
  return out;
}

// str reads a string column.
export function str(
  item: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = item[key];
  return typeof v === "string" ? v : undefined;
}

// num reads a number column.
export function num(
  item: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = item[key];
  return typeof v === "number" ? v : undefined;
}

// blob copies a byte column. A missing column is undefined.
export function blob(
  item: Record<string, unknown>,
  key: string,
): Uint8Array | undefined {
  const v = item[key];
  if (!(v instanceof Uint8Array)) return undefined;
  return new Uint8Array(v);
}

// run executes a statement that does not return rows.
export function run(
  db: Database,
  sql: string,
  ...args: SQLQueryBindings[]
) {
  db.prepare(sql).run(...args);
}

// countOf reads COUNT(*) AS n.
export function countOf(
  db: Database,
  sql: string,
  ...args: SQLQueryBindings[]
): number {
  const got = row(db, sql, ...args);
  if (got === undefined) return 0;
  return num(got, "n") ?? 0;
}

// wrote means a run() changed at least one row.
export function wrote(result: unknown): boolean {
  if (!isRec(result)) return false;
  const n = result.changes;
  if (typeof n === "number") return n > 0;
  if (typeof n === "bigint") return n > 0n;
  return false;
}
