// Bun SQLite client store for perf / Node-like environments.
// Mirrors memory + IDB IStore surface with durable tables.

import { Database } from "bun:sqlite";
import libsodiumCrypto from "../src/crypto";
import { b64tob, btob64, btoh, htob } from "../src/shared/binary";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/enclave";
import type {
  EntityID,
  Hash,
  HostHandle,
  ICrypto,
  IHostConnectionInfo,
  IHostMetadata,
  IMessageHead,
  MasterSeed,
} from "../src/shared/types";
import type {
  IDownloadMessage,
  IDownloadQueue,
  IHostRow,
  IHostStore,
  IMessageStore,
  ISeedStore,
  IStorableMessage,
  IStore,
  IStoredMessage,
  IUploadQueue,
} from "../src/types";
import { normalizeStoredMessageData, toStoredMessage } from "../src/types";

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
      idx INTEGER NOT NULL,
      lastSeq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS uploads (
      host TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (host, hash)
    );
    CREATE TABLE IF NOT EXISTS downloads (
      host TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kdm BLOB NOT NULL,
      eid BLOB NOT NULL,
      off INTEGER NOT NULL,
      ctr INTEGER NOT NULL,
      len INTEGER NOT NULL,
      hsh BLOB,
      headEnc BLOB,
      headEncHash BLOB,
      PRIMARY KEY (host, seq)
    );
    CREATE TABLE IF NOT EXISTS messages (
      hash TEXT PRIMARY KEY,
      eid BLOB NOT NULL,
      off INTEGER,
      ctr INTEGER,
      body BLOB,
      apld INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS messages_apld ON messages(apld);
    CREATE INDEX IF NOT EXISTS messages_eid ON messages(eid);
  `);
  return db;
}

class SqliteSeedStore implements ISeedStore {
  constructor(private db: Database, private crypto: ICrypto) {}

  async save(seed: MasterSeed) {
    this.db.prepare(
      "INSERT INTO seed (id, seed) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET seed = excluded.seed",
    ).run(seed);
    return new Enclave(seed, this.crypto);
  }

  async load() {
    const row = this.db.prepare("SELECT seed FROM seed WHERE id = 1").get() as
      | { seed: Uint8Array }
      | null;
    if (!row) return undefined;
    const seed = new Uint8Array(row.seed) as MasterSeed;
    return new Enclave(seed, this.crypto);
  }

  async wipe() {
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
    this.db.prepare(
      `INSERT INTO hosts (label, idx, lastSeq) VALUES (?, ?, 0)
       ON CONFLICT(label) DO UPDATE SET idx = excluded.idx`,
    ).run(info.label, idx);
  }

  async touch(label: string, seq: number) {
    this.db.prepare(
      "UPDATE hosts SET lastSeq = ? WHERE label = ? AND lastSeq < ?",
    ).run(seq, label, seq);
  }

  async get(label: string): Promise<IHostRow<Handle> | undefined> {
    const row = this.db.prepare(
      "SELECT label, idx, lastSeq FROM hosts WHERE label = ?",
    ).get(label) as { label: string; idx: number; lastSeq: number } | null;
    if (!row) return undefined;
    const handle = this.handles.get(label);
    if (handle === undefined) return undefined;
    return {
      label: row.label,
      idx: row.idx,
      lastSeq: row.lastSeq,
      handle,
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
    this.db.prepare("DELETE FROM hosts WHERE label = ?").run(label);
  }

  async list(): Promise<Iterable<IHostRow<Handle>>> {
    const rows = this.db.prepare(
      "SELECT label, idx, lastSeq FROM hosts",
    ).all() as { label: string; idx: number; lastSeq: number }[];
    const out: IHostRow<Handle>[] = [];
    for (const row of rows) {
      const handle = this.handles.get(row.label);
      if (handle === undefined) continue;
      out.push({
        label: row.label,
        idx: row.idx,
        lastSeq: row.lastSeq,
        handle,
      });
    }
    return out;
  }

  async wipe() {
    this.handles.clear();
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
        (host, seq, kdm, eid, off, ctr, len, hsh, headEnc, headEncHash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const m of msgs) {
        const { head } = m;
        ins.run(
          m.host,
          m.seq,
          m.kdm,
          head.eid,
          head.off,
          head.ctr,
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

  async deq(host: string, seqs: Iterable<number>) {
    const del = this.db.prepare(
      "DELETE FROM downloads WHERE host = ? AND seq = ?",
    );
    this.db.exec("BEGIN");
    try {
      for (const seq of seqs) {
        del.run(host, seq);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async list(): Promise<IDownloadMessage[]> {
    const rows = this.db.prepare(
      `SELECT host, seq, kdm, eid, off, ctr, len, hsh, headEnc, headEncHash
       FROM downloads`,
    ).all() as {
      host: string;
      seq: number;
      kdm: Uint8Array;
      eid: Uint8Array;
      off: number;
      ctr: number;
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
        len: row.len,
        ...(row.hsh ? { hsh: new Uint8Array(row.hsh) } : {}),
      };
      return {
        host: row.host,
        seq: row.seq,
        kdm: new Uint8Array(row.kdm),
        head,
        ...(row.headEnc
          ? { headEnc: new Uint8Array(row.headEnc) }
          : {}),
        ...(row.headEncHash
          ? { headEncHash: new Uint8Array(row.headEncHash) as Hash }
          : {}),
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
      `INSERT OR REPLACE INTO messages (hash, eid, off, ctr, body, apld)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const results: Status[] = [];
    this.db.exec("BEGIN");
    try {
      for (const { key, data } of messages) {
        const n = normalizeStoredMessageData(data);
        ins.run(
          btob64(key),
          n.eid,
          n.off ?? null,
          n.ctr ?? null,
          n.body ?? null,
          n.apld ? 1 : 0,
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

  async get(key: Hash): Promise<IStoredMessage | undefined> {
    const row = this.db.prepare(
      "SELECT hash, eid, off, ctr, body, apld FROM messages WHERE hash = ?",
    ).get(btob64(key)) as {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      body: Uint8Array | null;
      apld: number;
    } | null;
    if (!row) return undefined;
    return await toStoredMessage(key, {
      eid: new Uint8Array(row.eid) as EntityID,
      ...(row.off !== null ? { off: row.off } : {}),
      ...(row.ctr !== null ? { ctr: row.ctr } : {}),
      ...(row.body ? { body: new Uint8Array(row.body) } : {}),
      apld: row.apld === 1,
    }, this.crypto);
  }

  async has(key: Hash) {
    const row = this.db.prepare(
      "SELECT 1 AS o FROM messages WHERE hash = ?",
    ).get(btob64(key)) as { o: number } | null;
    return row !== null;
  }

  async list(): Promise<Iterable<IStoredMessage>> {
    const rows = this.db.prepare(
      "SELECT hash, eid, off, ctr, body, apld FROM messages",
    ).all() as {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      body: Uint8Array | null;
      apld: number;
    }[];
    return await Promise.all(
      rows.map((row) =>
        toStoredMessage(b64tob(row.hash) as Hash, {
          eid: new Uint8Array(row.eid) as EntityID,
          ...(row.off !== null ? { off: row.off } : {}),
          ...(row.ctr !== null ? { ctr: row.ctr } : {}),
          ...(row.body ? { body: new Uint8Array(row.body) } : {}),
          apld: row.apld === 1,
        }, this.crypto)
      ),
    );
  }

  async last(eid: EntityID): Promise<IStoredMessage | undefined> {
    // Compare in JS; eid blob equality in SQL is fine for exact match filter.
    const rows = this.db.prepare(
      "SELECT hash, eid, off, ctr, body, apld FROM messages WHERE eid = ?",
    ).all(eid) as {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      body: Uint8Array | null;
      apld: number;
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
    return await toStoredMessage(b64tob(best.hash) as Hash, {
      eid: new Uint8Array(best.eid) as EntityID,
      ...(best.off !== null ? { off: best.off } : {}),
      ...(best.ctr !== null ? { ctr: best.ctr } : {}),
      ...(best.body ? { body: new Uint8Array(best.body) } : {}),
      apld: best.apld === 1,
    }, this.crypto);
  }

  async listUnapplied(): Promise<IStoredMessage[]> {
    const rows = this.db.prepare(
      "SELECT hash, eid, off, ctr, body, apld FROM messages WHERE apld = 0",
    ).all() as {
      hash: string;
      eid: Uint8Array;
      off: number | null;
      ctr: number | null;
      body: Uint8Array | null;
      apld: number;
    }[];
    return await Promise.all(
      rows.map((row) =>
        toStoredMessage(b64tob(row.hash) as Hash, {
          eid: new Uint8Array(row.eid) as EntityID,
          ...(row.off !== null ? { off: row.off } : {}),
          ...(row.ctr !== null ? { ctr: row.ctr } : {}),
          ...(row.body ? { body: new Uint8Array(row.body) } : {}),
          apld: false,
        }, this.crypto)
      ),
    );
  }

  async markApplied(keys: Iterable<Hash>) {
    const upd = this.db.prepare(
      "UPDATE messages SET apld = 1 WHERE hash = ?",
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

  async wipe() {
    this.db.exec("DELETE FROM messages");
  }
}

export class SqliteStore<Handle extends HostHandle> implements IStore<Handle> {
  seed: SqliteSeedStore;
  hosts: SqliteHostStore<Handle>;
  uploads: SqliteUploadQueue;
  downloads: SqliteDownloadQueue;
  messages: SqliteMessageStore;
  private db: Database;

  constructor(path: string, crypto: ICrypto = libsodiumCrypto) {
    this.db = openDb(path);
    this.seed = new SqliteSeedStore(this.db, crypto);
    this.hosts = new SqliteHostStore<Handle>(this.db);
    this.uploads = new SqliteUploadQueue(this.db);
    this.downloads = new SqliteDownloadQueue(this.db);
    this.messages = new SqliteMessageStore(this.db, crypto);
  }

  async wipe() {
    await this.seed.wipe();
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }

  close() {
    this.db.close();
  }
}
