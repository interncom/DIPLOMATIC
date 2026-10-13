// Names for the account catalog, the protocol database, and EntDB.

import { btoh } from "../../shared/binary";

/** Account catalog. Unlock reads only this database. */
export const META_DB_NAME = "meta";
export const META_DB_VERSION = 1;

/** Protocol database: archive, queues, hosts, realm counters, host cursors. */
export const DATA_DB_VERSION = 9;

// Mints the stable account id stored on the catalog row.
export function mintAcct(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return btoh(bytes);
}

// Protocol database name for an account.
export function dataDbName(acct: string): string {
  return `data-${acct}`;
}

// EntDB name for an account.
export function entsDbName(acct: string): string {
  return `ents-${acct}`;
}

// Fills acct and data. An existing data name is kept.
export function placeAccount(
  acct: string | undefined,
  data: string | undefined,
): { acct: string; data: string } {
  const id = acct !== undefined && acct !== "" ? acct : mintAcct();
  if (data !== undefined && data !== "") return { acct: id, data };
  return { acct: id, data: dataDbName(id) };
}

// EntDB name. An existing name is kept.
export function assignEnts(acct: string, current: string | undefined): string {
  if (current !== undefined && current !== "") return current;
  return entsDbName(acct);
}
