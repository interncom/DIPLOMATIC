import type { IKDM } from "../../shared/codecs/kdm";
import { Status } from "../../shared/consts";
import { nullKDM } from "../../shared/crypto/derivation";
import { IHostConnectionInfo, IHostMetadata } from "../../shared/types";
import type { HostSeqsUpdate, IHostRow, IHostStore } from "../../types";
import { nextCursor, projectCursors, type RealmCursor } from "../cursor";
import { HOST_SEQS_TABLE, HOSTS_TABLE } from "./store";

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function isCursor(v: unknown): v is {
  host: string;
  label: string;
  index: number;
  lastSeq: number;
} {
  if (!isRec(v)) return false;
  return typeof v.host === "string" &&
    typeof v.label === "string" &&
    typeof v.index === "number" && Number.isInteger(v.index) &&
    typeof v.lastSeq === "number" && Number.isInteger(v.lastSeq) &&
    v.lastSeq >= 0;
}

function cursorsOf(raw: unknown): RealmCursor[] {
  const out: RealmCursor[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!isCursor(item)) continue;
    out.push({ label: item.label, index: item.index, lastSeq: item.lastSeq });
  }
  return out;
}

function byHost(raw: unknown): Map<string, RealmCursor[]> {
  const out = new Map<string, RealmCursor[]>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!isCursor(item)) continue;
    const list = out.get(item.host) ?? [];
    list.push({ label: item.label, index: item.index, lastSeq: item.lastSeq });
    out.set(item.host, list);
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function idbRowToHostRow(row: any, cursors: RealmCursor[]): IHostRow<URL> {
  const projected = projectCursors(cursors);
  const host: IHostRow<URL> = {
    label: row.label,
    handle: new URL(row.handle),
    idx: row.idx,
    lastSeq: projected.lastSeq,
    clockOffset: row.clockOffset,
    subscription: row.subscription,
  };
  if (projected.seqs !== undefined) host.seqs = projected.seqs;
  return host;
}

// Host identity only. Cursors live in host_seqs.
function storedHost(
  info: IHostConnectionInfo<URL> & Partial<IHostMetadata>,
) {
  const row: {
    label: string;
    handle: string;
    idx?: number;
    clockOffset?: number;
    subscription?: IHostMetadata["subscription"];
  } = {
    label: info.label,
    handle: info.handle.toString(),
  };
  if (info.idx !== undefined) row.idx = info.idx;
  if (info.clockOffset !== undefined) row.clockOffset = info.clockOffset;
  if (info.subscription !== undefined) row.subscription = info.subscription;
  return row;
}

export class IDBHostStore implements IHostStore<URL> {
  constructor(private db: IDBDatabase) {}

  /**
   * Upsert connection info. Same label + same handle/idx keeps cursors and
   * host meta (safe re-link). Changing handle/idx clears host_seqs.
   */
  async add(info: IHostConnectionInfo<URL>) {
    const prev = await this.get(info.label);
    const same = prev !== undefined &&
      prev.handle.href === info.handle.href &&
      (prev.idx ?? 0) === (info.idx ?? 0);
    const row = storedHost(
      same && prev !== undefined
        ? {
          ...info,
          clockOffset: prev.clockOffset,
          subscription: prev.subscription,
        }
        : info,
    );
    const tx = this.db.transaction(
      [HOSTS_TABLE, HOST_SEQS_TABLE],
      "readwrite",
    );
    const hosts = tx.objectStore(HOSTS_TABLE);
    const seqs = tx.objectStore(HOST_SEQS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      if (same) {
        hosts.put(row);
        return;
      }
      const keys = seqs.index("host").getAllKeys(info.label);
      keys.onsuccess = () => {
        for (const key of keys.result) seqs.delete(key);
        hosts.put(row);
      };
    });
  }

  // Cursor only advances. Concurrent peek/push/notif must not regress it.
  async touch(label: string, seq: number, realm?: IKDM) {
    return this.recordSeqs(label, { lastSeq: seq }, realm);
  }

  // Writes one host_seqs row. The host identity row is left alone.
  async recordSeqs(label: string, u: HostSeqsUpdate, realm?: IKDM) {
    const r = realm ?? nullKDM;
    const tx = this.db.transaction(
      [HOSTS_TABLE, HOST_SEQS_TABLE],
      "readwrite",
    );
    const hosts = tx.objectStore(HOSTS_TABLE);
    const seqs = tx.objectStore(HOST_SEQS_TABLE);
    const key = [label, r.label, r.index];
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const hostReq = hosts.get(label);
      hostReq.onsuccess = () => {
        if (!hostReq.result) return;
        const curReq = seqs.get(key);
        curReq.onsuccess = () => {
          const row = curReq.result;
          const cur = isCursor(row) ? row.lastSeq : 0;
          const next = nextCursor(cur, u);
          if (next === undefined) return;
          seqs.put({
            host: label,
            label: r.label,
            index: r.index,
            lastSeq: next,
          });
        };
      };
    });
  }

  async get(label: string) {
    const tx = this.db.transaction(
      [HOSTS_TABLE, HOST_SEQS_TABLE],
      "readonly",
    );
    const hosts = tx.objectStore(HOSTS_TABLE);
    const seqs = tx.objectStore(HOST_SEQS_TABLE);
    return new Promise<IHostRow<URL> | undefined>((resolve, reject) => {
      tx.onerror = () => reject(tx.error);
      let hostRow: unknown;
      let seqRows: unknown;
      let left = 2;
      const finish = () => {
        left -= 1;
        if (left > 0) return;
        if (!isRec(hostRow)) {
          resolve(undefined);
          return;
        }
        resolve(idbRowToHostRow(hostRow, cursorsOf(seqRows)));
      };
      const hostReq = hosts.get(label);
      hostReq.onsuccess = () => {
        hostRow = hostReq.result;
        finish();
      };
      const seqReq = seqs.index("host").getAll(label);
      seqReq.onsuccess = () => {
        seqRows = seqReq.result;
        finish();
      };
    });
  }

  async set(label: string, meta: IHostMetadata) {
    const row = await this.get(label);
    if (!row) {
      return Status.NotFound;
    }
    try {
      await this.put(storedHost({ ...row, ...meta }));
      return Status.Success;
    } catch {
      return Status.DatabaseError;
    }
  }

  async del(label: string) {
    const tx = this.db.transaction(
      [HOSTS_TABLE, HOST_SEQS_TABLE],
      "readwrite",
    );
    const hosts = tx.objectStore(HOSTS_TABLE);
    const seqs = tx.objectStore(HOST_SEQS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      hosts.delete(label);
      const keys = seqs.index("host").getAllKeys(label);
      keys.onsuccess = () => {
        for (const key of keys.result) seqs.delete(key);
      };
    });
  }

  async list() {
    const tx = this.db.transaction(
      [HOSTS_TABLE, HOST_SEQS_TABLE],
      "readonly",
    );
    const hosts = tx.objectStore(HOSTS_TABLE);
    const seqs = tx.objectStore(HOST_SEQS_TABLE);
    return new Promise<IHostRow<URL>[]>((resolve, reject) => {
      tx.onerror = () => reject(tx.error);
      let hostRows: unknown;
      let seqRows: unknown;
      let left = 2;
      const finish = () => {
        left -= 1;
        if (left > 0) return;
        const grouped = byHost(seqRows);
        const out: IHostRow<URL>[] = [];
        if (Array.isArray(hostRows)) {
          for (const row of hostRows) {
            if (!isRec(row) || typeof row.label !== "string") continue;
            out.push(idbRowToHostRow(row, grouped.get(row.label) ?? []));
          }
        }
        resolve(out);
      };
      const hostReq = hosts.getAll();
      hostReq.onsuccess = () => {
        hostRows = hostReq.result;
        finish();
      };
      const seqReq = seqs.getAll();
      seqReq.onsuccess = () => {
        seqRows = seqReq.result;
        finish();
      };
    });
  }

  async wipe() {
    const tx = this.db.transaction(
      [HOSTS_TABLE, HOST_SEQS_TABLE],
      "readwrite",
    );
    const hosts = tx.objectStore(HOSTS_TABLE);
    const seqs = tx.objectStore(HOST_SEQS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      hosts.clear();
      seqs.clear();
    });
  }

  private put(row: ReturnType<typeof storedHost>) {
    const tx = this.db.transaction(HOSTS_TABLE, "readwrite");
    const store = tx.objectStore(HOSTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.put(row);
    });
  }
}
