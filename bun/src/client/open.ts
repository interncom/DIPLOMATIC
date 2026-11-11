// Opens a native app folder: SQLite files plus a blobs directory.

import { noble as crypto } from "../../../web/src/shared/crypto/noble.ts";
import type { ICrypto } from "../../../web/src/shared/types.ts";
import type { IEntDB } from "../../../web/src/entdb/entdb.ts";
import type { ValStat } from "../../../web/src/shared/valstat.ts";
import { SqliteAccountStore } from "./data/account.ts";
import { blobsDir, metaPath } from "./dir.ts";
import { ensureDir, openDB } from "./sql.ts";
import { SqliteStore } from "./store.ts";

export type Disk = {
  dir: string;
  store: SqliteStore;
  openEnts: (label: string) => Promise<ValStat<IEntDB>>;
  close: () => void;
};

// openDisk creates dir and blobs/ and opens the account catalog.
// crypto defaults to the Bun noble bundle.
// maxInlineBytes spills message bodies above that size.
export function openDisk(
  dir: string,
  opts?: { crypto?: ICrypto; maxInlineBytes?: number },
): Disk {
  ensureDir(dir);
  ensureDir(blobsDir(dir));
  const used = opts?.crypto ?? crypto;
  const account = new SqliteAccountStore(openDB(metaPath(dir)), used, dir);
  const store = new SqliteStore(dir, account, used, opts?.maxInlineBytes);
  account.setCloser(() => store.closeData());
  return {
    dir,
    store,
    openEnts: (label) => store.openEnts(label),
    close: () => store.close(),
  };
}
