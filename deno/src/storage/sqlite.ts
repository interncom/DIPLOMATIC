import { Database } from "https://deno.land/x/sqlite3/mod.ts";
import { btoh } from "../../../shared/binary.ts";
import type { IStorage } from "../../../shared/types.ts";
import { Encoder } from "../../../shared/codec.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";
import { Status } from "../../../shared/consts.ts";
import { nullSubMeta } from "../../../web/src/shared/types.ts";
import { err, ok } from "../../../shared/valstat.ts";

const db = new Database("diplomatic.db");
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

const sqliteStorage: IStorage = {
  async addUser(pubKey) {
    try {
      const pubKeyHex = btoh(pubKey);
      db.exec(
        "INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING",
        pubKeyHex,
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
        "SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?)",
      ).value<[boolean]>(pubKeyHex);
      const has = row ? row[0] : false;
      return ok(has);
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
        const row = db.prepare("SELECT MAX(seq) FROM bags WHERE userPubKey = ?")
          .value<[number]>(pubKeyHex);
        let maxSeq = row ? row[0] || 0 : 0;
        const seqs: number[] = [];
        for (const bag of bags) {
          maxSeq += 1;
          const enc = new Encoder();
          enc.writeStruct(peekItemHeadCodec, bag);
          db.exec(
            "INSERT INTO bags (userPubKey, seq, headCph, bodyCph) VALUES (?, ?, ?, ?)",
            pubKeyHex,
            maxSeq,
            enc.result(),
            bag.bodyCph,
          );
          seqs.push(maxSeq);
        }
        db.exec("COMMIT");
        return ok(seqs);
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // ignore rollback errors
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
        ).values<[number, Uint8Array]>(pubKeyHex, ...part);
        for (const [seq, bodyCph] of rows) {
          if (bodyCph) {
            out.push({ seq, bodyCph: new Uint8Array(bodyCph) });
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
      ).values<[number, Uint8Array]>(pubKeyHex, minSeq);
      return ok(rows.map(([seq, headCph]: [number, Uint8Array]) => ({
        seq,
        headCph: new Uint8Array(headCph),
      })));
    } catch {
      return err(Status.StorageError);
    }
  },
};

export default sqliteStorage;
