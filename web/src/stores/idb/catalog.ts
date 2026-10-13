// Looks up the EntDB database name for an account.

import crypto from "../../crypto";
import { IDBAccountStore } from "./account";
import { openMetaDB } from "./migrate";

// Records and returns the EntDB name for `label`.
export async function entsNameFor(label: string): Promise<string> {
  const meta = await openMetaDB();
  try {
    const store = new IDBAccountStore(meta, crypto);
    return await store.ensureEnts(label);
  } finally {
    meta.close();
  }
}
