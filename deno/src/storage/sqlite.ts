import { DB } from "https://deno.land/x/sqlite/mod.ts";
import { btoh } from "../../../shared/binary.ts";
import type { IStorage } from "../../../shared/types.ts";
import { Encoder } from "../../../shared/codec.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";
import { Status } from "../../../shared/consts.ts";
import { nullSubMeta } from "../../../web/src/shared/types.ts";
import { err, ok } from "../../../shared/valstat.ts";

const db = new DB("diplomatic.db");
db.query(`
  CREATE TABLE IF NOT EXISTS users (
    pubKey TEXT PRIMARY KEY
  );
`);
db.query(`
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
      db.query("INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING", [
        pubKeyHex,
      ]);
      return ok(undefined);
    } catch {
      return err(Status.StorageError);
    }
  },

  async hasUser(pubKey) {
    try {
      const pubKeyHex = btoh(pubKey);
      const rows = db.query<[boolean]>(
        "SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?)",
        [pubKeyHex],
      );
      const row = rows?.[0];
      const has = row?.[0];
      return ok(has ?? false);
    } catch {
      return err(Status.StorageError);
    }
  },

  async subMeta(pubKey) {
    // NOTE: a real host implementation would compute subscription info here.
    return ok(nullSubMeta);
  },

  async setBag(pubKey, bag) {
    try {
      const pubKeyHex = btoh(pubKey);
      const rows = db.query<[number]>(
        "SELECT MAX(seq) FROM bag WHERE userPubKey = ?",
        [pubKeyHex],
      );
      const maxSeq = rows[0]?.[0] || 0;
      const seq = maxSeq + 1;
      const enc = new Encoder();
      enc.writeStruct(peekItemHeadCodec, bag);
      const headCph = enc.result();
      const bodyCph = bag.bodyCph;
      db.query(
        "INSERT INTO bag (userPubKey, seq, headCph, bodyCph) VALUES (?, ?, ?, ?)",
        [pubKeyHex, seq, headCph, bodyCph],
      );
      return ok(seq);
    } catch {
      return err(Status.StorageError);
    }
  },

  async getBody(pubKey, seq) {
    try {
      const pubKeyHex = btoh(pubKey);
      const rows = db.query<[Uint8Array]>(
        "SELECT bodyCph FROM bag WHERE userPubKey = ? AND seq = ?",
        [pubKeyHex, seq],
      );
      const row = rows[0];
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
      const rows = db.query<[number, Uint8Array]>(
        "SELECT seq, headCph FROM bag WHERE userPubKey = ? AND seq > ? ORDER BY seq",
        [pubKeyHex, minSeq],
      );
      return ok(rows.map(([seq, headCph]) => ({
        seq,
        headCph: new Uint8Array(headCph),
      })));
    } catch {
      return err(Status.StorageError);
    }
  },
};

export default sqliteStorage;
