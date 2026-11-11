// Paths in one native app folder.
// meta.sqlite, data-<acct>.sqlite, ents-<acct>.sqlite, and blobs/.
// acct is the catalog id IndexedDB uses in those database names, not a realm.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { META_DB_NAME } from "../../../web/src/stores/idb/names.ts";

const dataRe = /^data-[0-9a-f]{32}$/;
const entsRe = /^ents-[0-9a-f]{32}$/;

// metaPath is the account catalog file.
export function metaPath(dir: string): string {
  return join(dir, `${META_DB_NAME}.sqlite`);
}

// dataPath is the protocol file for a catalog data name.
// dataPath returns undefined when name is not data-<acct>.
export function dataPath(dir: string, name: string): string | undefined {
  if (!dataRe.test(name)) return undefined;
  return join(dir, `${name}.sqlite`);
}

// entsPath is the EntDB file for a catalog ents name.
// entsPath returns undefined when name is not ents-<acct>.
export function entsPath(dir: string, name: string): string | undefined {
  if (!entsRe.test(name)) return undefined;
  return join(dir, `${name}.sqlite`);
}

// blobsDir holds message bodies that do not fit in a row.
export function blobsDir(dir: string): string {
  return join(dir, "blobs");
}

// rmDB deletes a database and its WAL sidecars.
export function rmDB(path: string) {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}
