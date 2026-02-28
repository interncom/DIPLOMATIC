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
  CREATE TABLE IF NOT EXISTS bag (
      userPubKey TEXT,
      seq INTEGER,
      headCph BLOB,
      bodyCph BLOB,
      PRIMARY KEY (userPubKey, seq)
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

  async setBag(pubKey, bag) {
    try {
      const pubKeyHex = btoh(pubKey);
      const row = db.prepare("SELECT MAX(seq) FROM bag WHERE userPubKey = ?")
        .value<[number]>(pubKeyHex);
      const maxSeq = row ? row[0] || 0 : 0;
      const seq = maxSeq + 1;
      const enc = new Encoder();
      enc.writeStruct(peekItemHeadCodec, bag);
      const headCph = enc.result();
      const bodyCph = bag.bodyCph;
      db.exec(
        "INSERT INTO bag (userPubKey, seq, headCph, bodyCph) VALUES (?, ?, ?, ?)",
        pubKeyHex,
        seq,
        headCph,
        bodyCph,
      );
      return ok(seq);
    } catch {
      return err(Status.StorageError);
    }
  },

  async getBody(pubKey, seq) {
    try {
      const pubKeyHex = btoh(pubKey);
      const row = db.prepare(
        "SELECT bodyCph FROM bag WHERE userPubKey = ? AND seq = ?",
      ).value<[Uint8Array]>(pubKeyHex, seq);
      if (!row) {
        return ok(undefined);
      }
      return ok(new Uint8Array(row[0]));
    } catch {
      return err(Status.StorageError);
    }
  },

  async listHeads(pubKey, minSeq) {
    try {
      const pubKeyHex = btoh(pubKey);
      const rows = db.prepare(
        "SELECT seq, headCph FROM bag WHERE userPubKey = ? AND seq > ? ORDER BY seq",
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
