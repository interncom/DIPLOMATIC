import { Database } from "bun:sqlite";
import { btoh } from "../../../shared/binary.ts";
import type { IStorage } from "../../../shared/types.ts";
import { nullSubMeta } from "../../../shared/types.ts";
import { Encoder } from "../../../shared/codec.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";
import { Status } from "../../../shared/consts.ts";
import { err, ok } from "../../../shared/valstat.ts";

/** Fresh SQLite-backed IStorage (WAL). Path defaults to ./diplomatic.db. */
export function createSqliteStorage(path = "diplomatic.db"): IStorage {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      pubKey TEXT PRIMARY KEY
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bags (
      userPubKey TEXT,
      seq INTEGER,
      headCph BLOB,
      bodyCph BLOB,
      PRIMARY KEY (userPubKey, seq),
      UNIQUE (userPubKey, seq)
    );
  `);

  return {
    async addUser(pubKey) {
      try {
        const pubKeyHex = btoh(pubKey);
        db.exec(
          "INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING",
          [pubKeyHex],
        );
        return ok(undefined);
      } catch {
        return err(Status.StorageError);
      }
    },

    async hasUser(pubKey) {
      try {
        const pubKeyHex = btoh(pubKey);
        const row = db.prepare(
          "SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?) AS ok",
        ).get(pubKeyHex) as { ok: number } | null;
        return ok(Boolean(row?.ok));
      } catch {
        return err(Status.StorageError);
      }
    },

    async subMeta(_pubKey) {
      // NOTE: a real host implementation would compute subscription info here.
      return ok(nullSubMeta);
    },

    async setBags(pubKey, bags) {
      if (bags.length < 1) return ok([]);
      try {
        const pubKeyHex = btoh(pubKey);
        // IMMEDIATE: take write lock before read so concurrent setBags cannot
        // both observe the same MAX(seq).
        db.exec("BEGIN IMMEDIATE");
        try {
          const row = db.prepare(
            "SELECT MAX(seq) AS m FROM bags WHERE userPubKey = ?",
          )
            .get(pubKeyHex) as { m: number | null };
          let maxSeq = row ? row.m || 0 : 0;
          const seqs: number[] = [];
          const insert = db.prepare(
            "INSERT INTO bags (userPubKey, seq, headCph, bodyCph) VALUES (?, ?, ?, ?)",
          );
          for (const bag of bags) {
            maxSeq += 1;
            const enc = new Encoder();
            enc.writeStruct(peekItemHeadCodec, bag);
            insert.run(pubKeyHex, maxSeq, enc.result(), bag.bodyCph);
            seqs.push(maxSeq);
          }
          db.exec("COMMIT");
          return ok(seqs);
        } catch (e) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // ignore
          }
          throw e;
        }
      } catch {
        return err(Status.StorageError);
      }
    },

    async getBodies(pubKey, seqs) {
      if (seqs.length < 1) return ok([]);
      try {
        const pubKeyHex = btoh(pubKey);
        const out: { seq: number; bodyCph: Uint8Array }[] = [];
        // SQLite rejects queries with too many bound parameters
        // ("too many SQL variables"). Match D1's ~100 bind budget; leave one
        // slot for userPubKey so each IN (...) stays at maxBinds-1 seqs.
        const maxBinds = 100;
        const chunk = maxBinds - 1;
        for (let i = 0; i < seqs.length; i += chunk) {
          const part = seqs.slice(i, i + chunk);
          const placeholders = part.map(() => "?").join(",");
          const rows = db.prepare(
            `SELECT seq, bodyCph FROM bags WHERE userPubKey = ? AND seq IN (${placeholders})`,
          ).all(pubKeyHex, ...part) as { seq: number; bodyCph: Uint8Array }[];
          for (const row of rows) {
            if (row.bodyCph) {
              out.push({ seq: row.seq, bodyCph: new Uint8Array(row.bodyCph) });
            }
          }
        }
        return ok(out);
      } catch {
        return err(Status.StorageError);
      }
    },

    async listHeads(pubKey, minSeq) {
      try {
        const pubKeyHex = btoh(pubKey);
        const rows = db.prepare(
          "SELECT seq, headCph FROM bags WHERE userPubKey = ? AND seq > ? ORDER BY seq",
        ).all(pubKeyHex, minSeq) as { seq: number; headCph: Uint8Array }[];
        return ok(rows.map((row) => ({
          seq: row.seq,
          headCph: new Uint8Array(row.headCph),
        })));
      } catch {
        return err(Status.StorageError);
      }
    },
  };
}

/** Default host DB path (./diplomatic.db). Prefer createSqliteStorage for tests. */
const sqliteStorage = createSqliteStorage();
export default sqliteStorage;
