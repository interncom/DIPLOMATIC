// Bun SQLite client store for perf / Node-like environments.
// Mirrors memory + IDB IStore surface with durable tables.

import { Database } from "bun:sqlite";
import libsodiumCrypto from "../src/crypto";
import { b64tob, btob64, btoh, htob } from "../src/shared/binary";
import type { IKDM } from "../src/shared/codecs/kdm";
import { Status } from "../src/shared/consts";
import { nullKDM } from "../src/shared/crypto/derivation";
import { err, ok } from "../src/shared/valstat";
import {
  nextCursor,
  projectCursors,
  type RealmCursor,
} from "../src/stores/cursor";
import { singleAccountLabel } from "../src/stores/label";
import {
  advanceRealm,
  decodeRealm,
  type IRealm,
  type IRealmStore,
  realmLabel,
} from "../src/stores/realm";
import { Enclave } from "../src/shared/crypto/enclave";
import type {
  EntityID,
  Hash,
  HostHandle,
  ICrypto,
  IHostConnectionInfo,
  IHostMetadata,
  IMessageHead,
} from "../src/shared/types";
import type {
  ApldState,
  HostSeqsUpdate,
  IAccountStore,
  IDownloadMessage,
  IDownloadQueue,
  IHostRow,
  IHostStore,
  IMessageStore,
  IStorableMessage,
  IStore,
  IStoredMessage,
  IUploadQueue,
  ListMsgsOpts,
} from "../src/types";
import {
  APLD_APPLIED,
  APLD_ERROR,
  APLD_PENDING,
  toStoredMessage,
} from "../src/types";

/** SQLite apld: 0 pending, 1 applied, 2 terminal error. */
function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

// Host cursors. A missing row is cursor 0.
function readCursors(
  db: Database,
  host: string,
): { lastSeq: number; seqs?: RealmCursor[] } {
  const rows: unknown = db.prepare(
    "SELECT label, idx, lastSeq FROM host_seqs WHERE host = ?",
  ).all(host);
  const cursors: RealmCursor[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!isRec(row)) continue;
      if (typeof row.label !== "string") continue;
      if (typeof row.idx !== "number" || typeof row.lastSeq !== "number") {
        continue;
      }
      cursors.push({
        label: row.label,
        index: row.idx,
        lastSeq: row.lastSeq,
      });
    }
  }
  return projectCursors(cursors);
}

function apldToSql(a: ApldState): number {
  if (a === APLD_APPLIED) return 1;
  if (a === APLD_ERROR) return 2;
  return 0;
}

function apldFromSql(n: number): ApldState {
  if (n === 1) return APLD_APPLIED;
  if (n === 2) return APLD_ERROR;
  return APLD_PENDING;
}

function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seed BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hosts (
      label TEXT PRIMARY KEY,
      idx INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_seqs (
      host TEXT NOT NULL,
      label TEXT NOT NULL,
      idx INTEGER NOT NULL,
      lastSeq INTEGER NOT NULL,
      PRIMARY KEY (host, label, idx)
    );
    CREATE TABLE IF NOT EXISTS uploads (
      host TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (host, hash)
    );
    CREATE TABLE IF NOT EXISTS downloads (
      host TEXT NOT NULL,
      rlabel TEXT NOT NULL DEFAULT '',
      ridx INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL,
      kdm BLOB NOT NULL,
      eid BLOB NOT NULL,
      off INTEGER NOT NULL,
      ctr INTEGER NOT NULL,
      typ TEXT NOT NULL DEFAULT '',
      len INTEGER NOT NULL,
      hsh BLOB,
      headEnc BLOB,
      headEncHash BLOB,
      PRIMARY KEY (host, rlabel, ridx, seq)
    );
    CREATE TABLE IF NOT EXISTS messages (
      hash TEXT PRIMARY KEY,
      eid BLOB NOT NULL,
      off INTEGER,
      ctr INTEGER,
      typ TEXT,
      body BLOB,
      apld INTEGER NOT NULL DEFAULT 0,
      err INTEGER,
      rlm TEXT
    );
    CREATE TABLE IF NOT EXISTS realms (
      account TEXT NOT NULL,
      label TEXT NOT NULL,
      idx INTEGER NOT NULL,
      prior TEXT,
      PRIMARY KEY (account, label)
    );
    CREATE INDEX IF NOT EXISTS messages_apld ON messages(apld);
    CREATE INDEX IF NOT EXISTS messages_eid ON messages(eid);
  `);
  return db;
}

/**
 * Session-only seed handle for perf harness. Does not write raw seed to SQLite
 * (Enclave is a one-way door). Durable identity in production uses PRF seal.
 */
class SqliteAccountStore implements IAccountStore {
  #enclave?: Enclave;
  #label?: string;

  constructor(private db: Database, private crypto: ICrypto) {}

  async save(enclave: Enclave, opts?: { persist?: boolean; label?: string }) {
    const [label, lst] = singleAccountLabel(
      this.#label,
      opts?.label,
      this.#enclave !== undefined,
    );
    if (lst !== Status.Success || label === undefined) {
      return err(Status.InvalidParam);
    }
    this.#label = label;
    this.#enclave = enclave;
    return ok(enclave);
  }

  async load() {
    return this.#enclave;
  }

  async wipe() {
    this.#enclave = undefined;
    this.#label = undefined;
    this.db.exec("DELETE FROM seed");
  }
}

class SqliteHostStore<Handle extends HostHandle> implements IHostStore<Handle> {
  /** Runtime handles (LPC objects / URLs) not persisted. */
  private handles = new Map<string, Handle>();

  constructor(private db: Database) {}

  async add(info: IHostConnectionInfo<Handle>) {
    this.handles.set(info.label, info.handle);
    const idx = info.idx ?? 0;
    const prev: unknown = this.db.prepare(
      "SELECT idx FROM hosts WHERE label = ?",
    ).get(info.label);
    if (isRec(prev) && typeof prev.idx === "number" && prev.idx !== idx) {
      this.db.prepare(
        "DELETE FROM host_seqs WHERE host = ? AND NOT (label = '' AND idx = 0)",
      ).run(info.label);
    }
    this.db.prepare(
      `INSERT INTO hosts (label, idx) VALUES (?, ?)
       ON CONFLICT(label) DO UPDATE SET idx = excluded.idx`,
    ).run(info.label, idx);
  }

  async touch(label: string, seq: number, realm?: IKDM) {
    await this.recordSeqs(label, { lastSeq: seq }, realm);
  }

  // Writes one host_seqs row. The default realm is label "" and idx 0.
  private writeRealmSeq(label: string, u: HostSeqsUpdate, realm: IKDM) {
    const host: unknown = this.db.prepare(
      "SELECT label FROM hosts WHERE label = ?",
    ).get(label);
    if (!isRec(host)) return;
    const curRow: unknown = this.db.prepare(
      "SELECT lastSeq FROM host_seqs WHERE host = ? AND label = ? AND idx = ?",
    ).get(label, realm.label, realm.index);
    let cur = 0;
    if (isRec(curRow) && typeof curRow.lastSeq === "number") {
      cur = curRow.lastSeq;
    }
    const next = nextCursor(cur, u);
    if (next === undefined) return;
    this.db.prepare(
      `INSERT INTO host_seqs (host, label, idx, lastSeq) VALUES (?, ?, ?, ?)
       ON CONFLICT(host, label, idx) DO UPDATE SET lastSeq = excluded.lastSeq`,
    ).run(label, realm.label, realm.index, next);
  }

  async recordSeqs(label: string, u: HostSeqsUpdate, realm?: IKDM) {
    this.writeRealmSeq(label, u, realm ?? nullKDM);
  }

  async get(label: string): Promise<IHostRow<Handle> | undefined> {
    const row = this.db.prepare(
      "SELECT label, idx FROM hosts WHERE label = ?",
    ).get(label) as {
      label: string;
      idx: number;
    } | null;
    if (!row) return undefined;
    const handle = this.handles.get(label);
    if (handle === undefined) return undefined;
    const cursors = readCursors(this.db, label);
    return {
      label: row.label,
      idx: row.idx,
      lastSeq: cursors.lastSeq,
      handle,
      ...(cursors.seqs !== undefined ? { seqs: cursors.seqs } : {}),
    };
  }

  async set(label: string, _meta: IHostMetadata) {
    const cur = await this.get(label);
    if (!cur) return Status.NotFound;
    // Subscription/clock meta not persisted in this store.
    return Status.Success;
  }

  async del(label: string) {
    this.handles.delete(label);
    this.db.prepare("DELETE FROM host_seqs WHERE host = ?").run(label);
    this.db.prepare("DELETE FROM hosts WHERE label = ?").run(label);
  }

  async list(): Promise<Iterable<IHostRow<Handle>>> {
    const rows = this.db.prepare(
      "SELECT label, idx FROM hosts",
    ).all() as {
      label: string;
      idx: number;
    }[];
    const out: IHostRow<Handle>[] = [];
    for (const row of rows) {
      const handle = this.handles.get(row.label);
      if (handle === undefined) continue;
      const cursors = readCursors(this.db, row.label);
      out.push({
        label: row.label,
        idx: row.idx,
        lastSeq: cursors.lastSeq,
        handle,
        ...(cursors.seqs !== undefined ? { seqs: cursors.seqs } : {}),
      });
    }
    return out;
  }

  async wipe() {
    this.handles.clear();
    this.db.exec("DELETE FROM host_seqs");
    this.db.exec("DELETE FROM hosts");
  }
}

class SqliteUploadQueue implements IUploadQueue {
  constructor(private db: Database) {}

  async enq(host: string, hshs: Iterable<Hash>) {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO uploads (host, hash) VALUES (?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const h of hshs) {
        ins.run(host, btoh(h));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async deq(host: string, hshs: Iterable<Hash>) {
    const del = this.db.prepare(
      "DELETE FROM uploads WHERE host = ? AND hash = ?",
    );
    this.db.exec("BEGIN");
    try {
      for (const h of hshs) {
        del.run(host, btoh(h));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async list(host: string): Promise<Hash[]> {
    const rows = this.db.prepare(
      "SELECT hash FROM uploads WHERE host = ?",
    ).all(host) as { hash: string }[];
    const out: Hash[] = [];
    for (const row of rows) {
      out.push(htob(row.hash) as Hash);
    }
    return out;
  }

  async count() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM uploads").get() as {
      n: number;
    };
    return row.n;
  }

  async wipe() {
    this.db.exec("DELETE FROM uploads");
  }
}

class SqliteDownloadQueue implements IDownloadQueue {
  constructor(private db: Database) {}

  async enq(msgs: Iterable<IDownloadMessage>) {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO downloads
        (host, rlabel, ridx, seq, kdm, eid, off, ctr, typ, len, hsh, headEnc, headEncHash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const m of msgs) {
        const { head } = m;
        ins.run(
          m.host,
          m.realm?.label ?? "",
          m.realm?.index ?? 0,
          m.seq,
          m.kdm,
          head.eid,
          head.off,
          head.ctr,
          head.typ ?? "",
          head.len,
          head.hsh ?? null,
          m.headEnc ?? null,
          m.headEncHash ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async deq(host: string, seqs: Iterable<number>, realm?: IKDM) {
    const del = this.db.prepare(
      "DELETE FROM downloads WHERE host = ? AND rlabel = ? AND ridx = ? AND seq = ?",
    );
    const rlabel = realm?.label ?? "";
    const ridx = realm?.index ?? 0;
    this.db.exec("BEGIN");
    try {
      for (const seq of seqs) {
        del.run(host, rlabel, ridx, seq);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async list(): Promise<IDownloadMessage[]> {
    const rows = this.db.prepare(
      `SELECT host, rlabel, ridx, seq, kdm, eid, off, ctr, typ, len, hsh, headEnc, headEncHash
       FROM downloads`,
    ).all() as {
      host: string;
      rlabel: string;
      ridx: number;
      seq: number;
      kdm: Uint8Array;
      eid: Uint8Array;
      off: number;
      ctr: number;
      typ: string | null;
      len: number;
      hsh: Uint8Array | null;
      headEnc: Uint8Array | null;
      headEncHash: Uint8Array | null;
    }[];
    return rows.map((row) => {
      const head: IMessageHead = {
        eid: new Uint8Array(row.eid) as EntityID,
        off: row.off,
        ctr: row.ctr,
        typ: row.typ ?? "",
        len: row.len,
        ...(row.hsh ? { hsh: new Uint8Array(row.hsh) } : {}),
      };
      const named = row.rlabel !== "" || row.ridx !== 0;
      return {
        host: row.host,
        seq: row.seq,
        kdm: new Uint8Array(row.kdm),
        head,
        ...(row.headEnc ? { headEnc: new Uint8Array(row.headEnc) } : {}),
        ...(row.headEncHash
          ? { headEncHash: new Uint8Array(row.headEncHash) as Hash }
          : {}),
        ...(named ? { realm: { label: row.rlabel, index: row.ridx } } : {}),
      };
    });
  }

  async count() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM downloads")
      .get() as { n: number };
    return row.n;
  }

  async wipe() {
    this.db.exec("DELETE FROM downloads");
  }
}

class SqliteMessageStore implements IMessageStore {
  constructor(private db: Database, private crypto: ICrypto) {}

  async add(messages: IStorableMessage[]): Promise<Status[]> {
    if (messages.length < 1) return [];
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO messages (hash, eid, off, ctr, typ, body, apld, err, rlm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const results: Status[] = [];
    this.db.exec("BEGIN");
    try {
      for (const { key, data } of messages) {
        ins.run(
          btob64(key),
          data.eid,
          data.off ?? null,
          data.ctr ?? null,
          data.typ ?? null,
          data.body ?? null,
          apldToSql(data.apld),
          data.err ?? null,
          realmLabel(data.rlm) ?? null,
        );
        results.push(Status.Success);
      }
      this.db.exec("COMMIT");
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      return messages.map(() => Status.DatabaseError);
    }
    return results;
  }

  async del(keys: Iterable<Hash>) {
    const del = this.db.prepare("DELETE FROM messages WHERE hash = ?");
    this.db.exec("BEGIN");
    try {
      for (const k of keys) {
        del.run(btob64(k));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private rowToStored(
    row: {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      typ: string | null;
      body: Uint8Array | null;
      apld: number;
      err: number | null;
      rlm: string | null;
    },
    key: Hash,
    opts?: { body?: boolean },
  ): Promise<IStoredMessage> {
    const apld = apldFromSql(row.apld);
    const rlm = realmLabel(row.rlm);
    // Pass body bytes for len; toStoredMessage omits payload/hsh when body: false.
    return toStoredMessage(
      key,
      {
        eid: new Uint8Array(row.eid) as EntityID,
        ...(row.off !== null ? { off: row.off } : {}),
        ...(row.ctr !== null ? { ctr: row.ctr } : {}),
        ...(row.typ ? { typ: row.typ } : {}),
        ...(row.body ? { body: new Uint8Array(row.body) } : {}),
        apld,
        ...(apld === APLD_ERROR && row.err !== null ? { err: row.err } : {}),
        ...(rlm !== undefined ? { rlm } : {}),
      },
      this.crypto,
      opts,
    );
  }

  async get(key: Hash): Promise<IStoredMessage | undefined> {
    const row = this.db.prepare(
      "SELECT hash, eid, off, ctr, typ, body, apld, err, rlm FROM messages WHERE hash = ?",
    ).get(btob64(key)) as {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      typ: string | null;
      body: Uint8Array | null;
      apld: number;
      err: number | null;
      rlm: string | null;
    } | null;
    if (!row) return undefined;
    return await this.rowToStored(row, key);
  }

  async has(key: Hash) {
    const row = this.db.prepare(
      "SELECT 1 AS o FROM messages WHERE hash = ?",
    ).get(btob64(key)) as { o: number } | null;
    return row !== null;
  }

  async list(opts?: ListMsgsOpts): Promise<IStoredMessage[]> {
    type Row = {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      typ: string | null;
      body: Uint8Array | null;
      apld: number;
      err: number | null;
      rlm: string | null;
    };
    const apld = opts?.apld;
    const body = opts?.body !== false;
    const rows = apld === undefined
      ? this.db.prepare(
        "SELECT hash, eid, off, ctr, typ, body, apld, err, rlm FROM messages",
      ).all() as Row[]
      : this.db.prepare(
        "SELECT hash, eid, off, ctr, typ, body, apld, err, rlm FROM messages WHERE apld = ?",
      ).all(apldToSql(apld)) as Row[];
    return await Promise.all(
      rows.map((row) =>
        this.rowToStored(row, b64tob(row.hash) as Hash, { body })
      ),
    );
  }

  async count(apld?: ApldState): Promise<number> {
    if (apld === undefined) {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM messages")
        .get() as {
          n: number;
        };
      return row.n;
    }
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE apld = ?",
    ).get(apldToSql(apld)) as { n: number };
    return row.n;
  }

  async listKeys(): Promise<Hash[]> {
    const rows = this.db.prepare("SELECT hash FROM messages").all() as {
      hash: string;
    }[];
    return rows.map((row) => b64tob(row.hash) as Hash);
  }

  async last(eid: EntityID): Promise<IStoredMessage | undefined> {
    // Compare in JS; eid blob equality in SQL is fine for exact match filter.
    const rows = this.db.prepare(
      "SELECT hash, eid, off, ctr, typ, body, apld, err, rlm FROM messages WHERE eid = ?",
    ).all(eid) as {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      typ: string | null;
      body: Uint8Array | null;
      apld: number;
      err: number | null;
      rlm: string | null;
    }[];
    if (rows.length < 1) return undefined;
    let best = rows[0];
    for (const row of rows) {
      const bc = best.ctr ?? 0;
      const rc = row.ctr ?? 0;
      const bo = best.off ?? 0;
      const ro = row.off ?? 0;
      if (rc > bc || (rc === bc && ro > bo)) best = row;
    }
    return await this.rowToStored(best, b64tob(best.hash) as Hash);
  }

  async markApplied(keys: Iterable<Hash>) {
    const upd = this.db.prepare(
      "UPDATE messages SET apld = 1, err = NULL WHERE hash = ?",
    );
    this.db.exec("BEGIN");
    try {
      for (const k of keys) {
        upd.run(btob64(k));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async markFailed(
    entries: Iterable<{ key: Hash; err: Status }>,
  ): Promise<void> {
    const upd = this.db.prepare(
      "UPDATE messages SET apld = 2, err = ? WHERE hash = ?",
    );
    this.db.exec("BEGIN");
    try {
      for (const { key, err } of entries) {
        upd.run(err, btob64(key));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async wipe() {
    this.db.exec("DELETE FROM messages");
  }
}

function realmFromSql(raw: unknown): IRealm | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  if (!("label" in raw) || !("idx" in raw)) return undefined;
  const { label, idx } = raw;
  if (typeof label !== "string" || typeof idx !== "number") return undefined;
  let prior: unknown;
  if ("prior" in raw && typeof raw.prior === "string" && raw.prior !== "") {
    try {
      prior = JSON.parse(raw.prior);
    } catch {
      prior = undefined;
    }
  }
  return decodeRealm({
    label,
    index: idx,
    ...(prior !== undefined ? { prior } : {}),
  });
}

// One file is one account. The account column remains for older perf databases.
class SqliteRealmStore implements IRealmStore {
  constructor(private db: Database) {}

  async list(): Promise<IRealm[]> {
    const raw = this.db.prepare(
      "SELECT label, idx, prior FROM realms WHERE account = ''",
    ).all();
    if (!Array.isArray(raw)) return [];
    const out: IRealm[] = [];
    for (const item of raw) {
      const realm = realmFromSql(item);
      if (realm !== undefined) out.push(realm);
    }
    return out;
  }

  async get(label: string): Promise<IRealm | undefined> {
    return realmFromSql(
      this.db.prepare(
        "SELECT label, idx, prior FROM realms WHERE account = '' AND label = ?",
      ).get(label),
    );
  }

  async put(label: string, index: number): Promise<Status> {
    const [next, st] = advanceRealm(label, await this.get(label), index);
    if (st !== Status.Success) return st;
    const prior = next.prior !== undefined ? JSON.stringify(next.prior) : null;
    this.db.prepare(
      `INSERT INTO realms (account, label, idx, prior)
       VALUES ('', ?, ?, ?)
       ON CONFLICT(account, label) DO UPDATE SET
         idx = excluded.idx, prior = excluded.prior`,
    ).run(next.label, next.index, prior);
    return Status.Success;
  }

  async wipe() {
    this.db.exec("DELETE FROM realms");
  }
}

export class SqliteStore<Handle extends HostHandle> implements IStore<Handle> {
  account: SqliteAccountStore;
  realms: SqliteRealmStore;
  hosts: SqliteHostStore<Handle>;
  uploads: SqliteUploadQueue;
  downloads: SqliteDownloadQueue;
  messages: SqliteMessageStore;
  private db: Database;

  constructor(path: string, crypto: ICrypto = libsodiumCrypto) {
    this.db = openDb(path);
    this.account = new SqliteAccountStore(this.db, crypto);
    this.realms = new SqliteRealmStore(this.db);
    this.hosts = new SqliteHostStore<Handle>(this.db);
    this.uploads = new SqliteUploadQueue(this.db);
    this.downloads = new SqliteDownloadQueue(this.db);
    this.messages = new SqliteMessageStore(this.db, crypto);
  }

  // One file holds every account.
  async bind(): Promise<Status> {
    return Status.Success;
  }

  async wipe() {
    // Match IDBStore: do not call account.wipe (identity separate from protocol data).
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }

  close() {
    this.db.close();
  }
}
