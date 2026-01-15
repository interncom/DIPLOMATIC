import { DB } from "https://deno.land/x/sqlite/mod.ts";
import { btoh } from "../../../shared/binary.ts";
import type { IStorage } from "../../../shared/types.ts";
import { Encoder } from "../../../shared/codec.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";

const db = new DB("diplomatic.db");
db.query(`
  CREATE TABLE IF NOT EXISTS users (
    pubKey TEXT PRIMARY KEY
  );
`);
db.query(`
  CREATE TABLE IF NOT EXISTS bag (
      userPubKey TEXT,
      recordedAt TEXT,
      sha256 BLOB,
      headCph BLOB,
      bodyCph BLOB,
      PRIMARY KEY (userPubKey, sha256)
    );
`);

const sqliteStorage: IStorage = {
  async addUser(pubKey) {
    const pubKeyHex = btoh(pubKey);
    db.query("INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING", [
      pubKeyHex,
    ]);
  },

  async hasUser(pubKey) {
    const pubKeyHex = btoh(pubKey);
    const rows = db.query<[boolean]>(
      "SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?)",
      [pubKeyHex],
    );
    const row = rows?.[0];
    const has = row?.[0];
    return has ?? false;
  },

  async setBag(pubKey, recordedAt, bag, sha256) {
    const pubKeyHex = btoh(pubKey);
    const recAtStr = recordedAt.toISOString();
    const enc = new Encoder();
    enc.writeStruct(peekItemHeadCodec, bag);
    const headCph = enc.result();
    const bodyCph = bag.bodyCph;
    db.query(
      "INSERT INTO bag (sha256, userPubKey, recordedAt, headCph, bodyCph) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      [sha256, pubKeyHex, recAtStr, headCph, bodyCph],
    );
  },

  async getBody(pubKey, sha256) {
    const pubKeyHex = btoh(pubKey);
    const rows = db.query<[Uint8Array]>(
      "SELECT bodyCph FROM bag WHERE userPubKey = ? AND sha256 = ?",
      [pubKeyHex, sha256],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return new Uint8Array(row[0]);
  },

  async listHeads(pubKey, begin, end) {
    const pubKeyHex = btoh(pubKey);
    const rows = db.query<[Uint8Array, string, Uint8Array]>(
      "SELECT sha256, recordedAt, headCph FROM bag WHERE userPubKey = ? AND recordedAt >= ? AND recordedAt <= ?",
      [pubKeyHex, begin, end],
    );
    return rows.map(([sha256, recordedAt, headCph]) => ({
      hash: sha256,
      recordedAt: new Date(recordedAt),
      headCph: new Uint8Array(headCph),
    }));
  },
};

export default sqliteStorage;
