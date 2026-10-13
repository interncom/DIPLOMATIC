// Helpers for per-realm host cursors and the realm keys around them.

import type { IKDM } from "../shared/codecs/kdm";
import { nullKDM } from "../shared/crypto/derivation";
import type { HostSeqsUpdate } from "../types";
import type { IRealm } from "./realm";

/** One host-realm cursor. The realm KDM plus the newest bag seq. */
export interface RealmCursor extends IKDM {
  lastSeq: number;
}

const downloadKeySymbol = Symbol("DownloadKey");

/** Key of one queued download: host label, realm, and seq. */
export type DownloadKey = string & { readonly [downloadKeySymbol]: true };

type CursorRow = { lastSeq: number; seqs?: RealmCursor[] };

// True for a missing KDM and for nullKDM.
export function isDefaultRealm(realm?: IKDM): boolean {
  if (realm === undefined) return true;
  return realm.label === nullKDM.label && realm.index === nullKDM.index;
}

// True when both KDMs are the same label and index.
export function sameRealm(a: IKDM, b: IKDM): boolean {
  return a.label === b.label && a.index === b.index;
}

// Map key for a realm KDM.
export function realmKey(realm: IKDM): string {
  return `${realm.label}\0${realm.index}`;
}

// Cursor for `realm` on this host. A missing cursor is 0.
export function cursorOf(row: CursorRow, realm: IKDM = nullKDM): number {
  if (isDefaultRealm(realm)) return row.lastSeq;
  const hit = row.seqs?.find((s) =>
    s.label === realm.label && s.index === realm.index
  );
  return hit?.lastSeq ?? 0;
}

// nullKDM plus each realm's current index and its prior indexes.
export function realmKDMs(rows: readonly IRealm[]): IKDM[] {
  const out: IKDM[] = [nullKDM];
  const seen = new Set<string>([realmKey(nullKDM)]);
  const add = (label: string, index: number) => {
    const realm: IKDM = label === "" && index === 0
      ? nullKDM
      : { label, index };
    const key = realmKey(realm);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(realm);
  };
  for (const row of rows) {
    add(row.label, row.index);
    if (row.prior === undefined) continue;
    for (const index of row.prior) add(row.label, index);
  }
  return out;
}

// Current counter for a stored label. Missing or "" is nullKDM.
export function realmKDM(
  label: string | undefined,
  rows: readonly IRealm[],
): IKDM {
  if (label === undefined || label === "") return nullKDM;
  for (const row of rows) {
    if (row.label === label) return { label: row.label, index: row.index };
  }
  return { label, index: 0 };
}

// Realm to store on a row. The default realm is omitted.
export function storedRealm(realm: IKDM): IKDM | undefined {
  if (isDefaultRealm(realm)) return undefined;
  return realm;
}

// Download-queue key. The default realm keeps `host:seq`.
export function downloadKey(
  host: string,
  seq: number,
  realm?: IKDM,
): DownloadKey {
  const r = realm ?? nullKDM;
  const key = isDefaultRealm(r)
    ? `${host}:${seq}`
    : `${host}:${r.label}:${r.index}:${seq}`;
  return key as DownloadKey;
}

// Next stored cursor. Undefined when the update would not change it.
export function nextCursor(
  cur: number,
  u: HostSeqsUpdate,
): number | undefined {
  if (u.setLastSeq !== undefined) return u.setLastSeq;
  if (u.lastSeq !== undefined && u.lastSeq > cur) return u.lastSeq;
  return undefined;
}

// Splits cursor rows into the default lastSeq and the other realms.
export function projectCursors(
  cursors: readonly RealmCursor[],
): { lastSeq: number; seqs?: RealmCursor[] } {
  let lastSeq = 0;
  const seqs: RealmCursor[] = [];
  for (const c of cursors) {
    if (isDefaultRealm(c)) lastSeq = c.lastSeq;
    else seqs.push(c);
  }
  if (seqs.length === 0) return { lastSeq };
  return { lastSeq, seqs };
}
