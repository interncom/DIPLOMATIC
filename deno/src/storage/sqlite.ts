import { Database } from "https://deno.land/x/sqlite3/mod.ts";
import { btoh } from "../../../shared/binary.ts";
import type { ISetBagResult, IStorage } from "../../../shared/types.ts";
import { Encoder } from "../../../shared/codec.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";
import { hashBytes, Status } from "../../../shared/consts.ts";
import { nullSubMeta } from "../../../web/src/shared/types.ts";
import { err, ok } from "../../../shared/valstat.ts";

const db = new Database("diplomatic.db");
db.exec("PRAGMA journal_mode=WAL;");
db.exec("PRAGMA synchronous=NORMAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    pubKey TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS bags (
    userPubKey TEXT,
    rlm BLOB,
    seq INTEGER,
    headCph BLOB,
    bodyCph BLOB,
    PRIMARY KEY (userPubKey, rlm, seq)
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
    const good: number[] = [];
    for (let i = 0; i < bags.length; i++) {
      if (bags[i].rlm.byteLength === hashBytes) good.push(i);
    }
    const seqByIdx = new Map<number, number>();
    if (good.length > 0) {
      try {
        const pubKeyHex = btoh(pubKey);
        // IMMEDIATE: take write lock before read so concurrent setBags cannot
        // both observe the same MAX(seq) within an rlm.
        db.exec("BEGIN IMMEDIATE");
        try {
          const maxBy = new Map<string, number>();
          const maxStmt = db.prepare(
            "SELECT MAX(seq) FROM bags WHERE userPubKey = ? AND rlm = ?",
          );
          for (const i of good) {
            const bag = bags[i];
            const key = btoh(bag.rlm);
            let max = maxBy.get(key);
            if (max === undefined) {
              const row = maxStmt.value<[number | null]>(pubKeyHex, bag.rlm);
              const n = row?.[0];
              max = typeof n === "number" ? n : 0;
            }
            max += 1;
            maxBy.set(key, max);
            const enc = new Encoder();
            enc.writeStruct(peekItemHeadCodec, bag);
            db.exec(
              "INSERT INTO bags (userPubKey, rlm, seq, headCph, bodyCph) VALUES (?, ?, ?, ?, ?)",
              pubKeyHex,
              bag.rlm,
              max,
              enc.result(),
              bag.bodyCph,
            );
            seqByIdx.set(i, max);
          }
          db.exec("COMMIT");
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
    }
    const out: ISetBagResult[] = [];
    for (let i = 0; i < bags.length; i++) {
      if (bags[i].rlm.byteLength !== hashBytes) {
        out.push({ status: Status.InvalidParam });
        continue;
      }
      const seq = seqByIdx.get(i);
      if (seq === undefined) return err(Status.StorageError);
      out.push({ status: Status.Success, seq });
    }
    return ok(out);
  },

  async getBodies(pubKey, rlm, seqs) {
    if (rlm.byteLength !== hashBytes) return err(Status.InvalidParam);
    if (seqs.length < 1) return ok([]);
    try {
      const pubKeyHex = btoh(pubKey);
      const out: { seq: number; bodyCph: Uint8Array }[] = [];
      // SQLite rejects queries with too many bound parameters
      // ("too many SQL variables"). Match D1's ~100 bind budget; leave
      // slots for userPubKey and rlm so each IN stays at maxBinds-2 seqs.
      const maxBinds = 100;
      const chunk = maxBinds - 2;
      for (let i = 0; i < seqs.length; i += chunk) {
        const part = seqs.slice(i, i + chunk);
        const placeholders = part.map(() => "?").join(",");
        const rows = db.prepare(
          `SELECT seq, bodyCph FROM bags WHERE userPubKey = ? AND rlm = ? AND seq IN (${placeholders})`,
        ).values<[number, Uint8Array]>(pubKeyHex, rlm, ...part);
        for (const [seq, bodyCph] of rows) {
          if (!bodyCph) continue;
          out.push({ seq, bodyCph: new Uint8Array(bodyCph) });
        }
      }
      return ok(out);
    } catch {
      return err(Status.StorageError);
    }
  },

  async listHeads(pubKey, rlm, minSeq) {
    if (rlm.byteLength !== hashBytes) return err(Status.InvalidParam);
    try {
      const pubKeyHex = btoh(pubKey);
      const rows = db.prepare(
        "SELECT seq, headCph FROM bags WHERE userPubKey = ? AND rlm = ? AND seq > ? ORDER BY seq",
      ).values<[number, Uint8Array]>(pubKeyHex, rlm, minSeq);
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
