// Host rows and realm cursors in the protocol SQLite file.

import type { Database } from "bun:sqlite";
import { Status } from "../../../../web/src/shared/consts.ts";
import type { IKDM } from "../../../../web/src/shared/codecs/kdm.ts";
import type { IUsageQuota } from "../../../../web/src/shared/codecs/usageQuota.ts";
import { nullKDM } from "../../../../web/src/shared/crypto/derivation.ts";
import type {
  IHostConnectionInfo,
  IHostMetadata,
  ISubscriptionMetadata,
} from "../../../../web/src/shared/types.ts";
import type {
  HostSeqsUpdate,
  IHostRow,
  IHostStore,
} from "../../../../web/src/types.ts";
import {
  nextCursor,
  projectCursors,
  type RealmCursor,
} from "../../../../web/src/stores/cursor.ts";
import { countOf, isRec, num, row, rows, run, str } from "../sql.ts";

function quota(v: unknown): IUsageQuota | undefined {
  if (!isRec(v) || typeof v.quota !== "number") return undefined;
  if (v.usage === undefined) return { quota: v.quota };
  if (typeof v.usage !== "number") return undefined;
  return { quota: v.quota, usage: v.usage };
}

// readSub parses subscription JSON. Bad JSON omits the subscription.
function readSub(raw: string | undefined): ISubscriptionMetadata | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRec(parsed)) return undefined;
  if (typeof parsed.term !== "number") return undefined;
  if (typeof parsed.elapsed !== "number") return undefined;
  const stat = quota(parsed.stat);
  const dyn = quota(parsed.dyn);
  if (stat === undefined || dyn === undefined) return undefined;
  return { term: parsed.term, elapsed: parsed.elapsed, stat, dyn };
}

function parseURL(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function cursorFrom(item: Record<string, unknown>): RealmCursor | undefined {
  const label = str(item, "label");
  const index = num(item, "idx");
  const lastSeq = num(item, "last_seq");
  if (label === undefined || index === undefined || lastSeq === undefined) {
    return undefined;
  }
  if (!Number.isInteger(index) || index < 0) return undefined;
  if (!Number.isInteger(lastSeq) || lastSeq < 0) return undefined;
  return { label, index, lastSeq };
}

function hostFrom(
  item: Record<string, unknown>,
  cursors: RealmCursor[],
): IHostRow<URL> | undefined {
  const label = str(item, "label");
  const handleRaw = str(item, "handle");
  if (label === undefined || handleRaw === undefined) return undefined;
  const handle = parseURL(handleRaw);
  if (handle === undefined) return undefined;
  const projected = projectCursors(cursors);
  const host: IHostRow<URL> = {
    label,
    handle,
    lastSeq: projected.lastSeq,
  };
  const idx = num(item, "idx");
  if (idx !== undefined) host.idx = idx;
  const clockOffset = num(item, "clock_off");
  if (clockOffset !== undefined) host.clockOffset = clockOffset;
  const sub = readSub(str(item, "sub"));
  if (sub !== undefined) host.subscription = sub;
  if (projected.seqs !== undefined) host.seqs = projected.seqs;
  return host;
}

type HostWrite = {
  label: string;
  handle: URL;
  idx?: number;
  clockOffset?: number;
  subscription?: ISubscriptionMetadata;
};

function writeHost(db: Database, info: HostWrite) {
  run(
    db,
    `INSERT INTO hosts (label, handle, idx, clock_off, sub)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(label) DO UPDATE SET
       handle = excluded.handle,
       idx = excluded.idx,
       clock_off = excluded.clock_off,
       sub = excluded.sub`,
    info.label,
    info.handle.toString(),
    info.idx ?? null,
    info.clockOffset ?? null,
    info.subscription !== undefined ? JSON.stringify(info.subscription) : null,
  );
}

function seqsOf(db: Database, host: string): RealmCursor[] {
  const out: RealmCursor[] = [];
  for (
    const item of rows(
      db,
      "SELECT label, idx, last_seq FROM host_seqs WHERE host = ?",
      host,
    )
  ) {
    const cursor = cursorFrom(item);
    if (cursor !== undefined) out.push(cursor);
  }
  return out;
}

export class SqlHosts implements IHostStore<URL> {
  constructor(private db: Database) {}

  // add upserts a host. The same handle and idx keeps cursors and host meta.
  // add returns true when those cursors are kept.
  async add(info: IHostConnectionInfo<URL>): Promise<boolean> {
    const prev = await this.get(info.label);
    const same = prev !== undefined &&
      prev.handle.href === info.handle.href &&
      (prev.idx ?? 0) === (info.idx ?? 0);
    const write: HostWrite = { label: info.label, handle: info.handle };
    if (info.idx !== undefined) write.idx = info.idx;
    if (same && prev !== undefined) {
      if (prev.clockOffset !== undefined) write.clockOffset = prev.clockOffset;
      if (prev.subscription !== undefined) {
        write.subscription = prev.subscription;
      }
    }
    this.db.transaction(() => {
      if (!same) {
        run(this.db, "DELETE FROM host_seqs WHERE host = ?", info.label);
      }
      writeHost(this.db, write);
    })();
    return same;
  }

  async get(label: string): Promise<IHostRow<URL> | undefined> {
    const item = row(
      this.db,
      "SELECT label, handle, idx, clock_off, sub FROM hosts WHERE label = ?",
      label,
    );
    if (item === undefined) return undefined;
    return hostFrom(item, seqsOf(this.db, label));
  }

  async del(label: string) {
    this.db.transaction(() => {
      run(this.db, "DELETE FROM hosts WHERE label = ?", label);
      run(this.db, "DELETE FROM host_seqs WHERE host = ?", label);
    })();
  }

  // set writes clock and subscription for a host that already exists.
  async set(label: string, meta: IHostMetadata): Promise<Status> {
    try {
      const prev = await this.get(label);
      if (prev === undefined) return Status.NotFound;
      writeHost(this.db, {
        label: prev.label,
        handle: prev.handle,
        idx: prev.idx,
        clockOffset: meta.clockOffset,
        subscription: meta.subscription,
      });
      return Status.Success;
    } catch {
      return Status.DatabaseError;
    }
  }

  async list(): Promise<IHostRow<URL>[]> {
    const grouped = new Map<string, RealmCursor[]>();
    for (
      const item of rows(
        this.db,
        "SELECT host, label, idx, last_seq FROM host_seqs",
      )
    ) {
      const host = str(item, "host");
      const cursor = cursorFrom(item);
      if (host === undefined || cursor === undefined) continue;
      const list = grouped.get(host) ?? [];
      list.push(cursor);
      grouped.set(host, list);
    }
    const out: IHostRow<URL>[] = [];
    for (
      const item of rows(
        this.db,
        "SELECT label, handle, idx, clock_off, sub FROM hosts",
      )
    ) {
      const label = str(item, "label");
      if (label === undefined) continue;
      const host = hostFrom(item, grouped.get(label) ?? []);
      if (host !== undefined) out.push(host);
    }
    return out;
  }

  async wipe() {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM hosts");
      this.db.exec("DELETE FROM host_seqs");
    })();
  }

  // touch advances one realm cursor when seq is greater.
  async touch(label: string, seq: number, realm?: IKDM) {
    return this.recordSeqs(label, { lastSeq: seq }, realm);
  }

  // recordSeqs writes one host_seqs row. The host row is left alone.
  async recordSeqs(label: string, u: HostSeqsUpdate, realm?: IKDM) {
    const r = realm ?? nullKDM;
    this.db.transaction(() => {
      const host = row(
        this.db,
        "SELECT label FROM hosts WHERE label = ?",
        label,
      );
      if (host === undefined) return;
      const cur = row(
        this.db,
        "SELECT last_seq FROM host_seqs WHERE host = ? AND label = ? AND idx = ?",
        label,
        r.label,
        r.index,
      );
      const next = nextCursor(
        cur === undefined ? 0 : num(cur, "last_seq") ?? 0,
        u,
      );
      if (next === undefined) return;
      run(
        this.db,
        `INSERT INTO host_seqs (host, label, idx, last_seq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(host, label, idx) DO UPDATE SET last_seq = excluded.last_seq`,
        label,
        r.label,
        r.index,
        next,
      );
    })();
  }

  // hasSeqs reports whether any cursor row is stored for this host.
  async hasSeqs(label: string): Promise<boolean> {
    return countOf(
      this.db,
      "SELECT COUNT(*) AS n FROM host_seqs WHERE host = ?",
      label,
    ) > 0;
  }
}
