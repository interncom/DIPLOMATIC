import { DB } from "https://deno.land/x/sqlite/mod.ts";
import type { IEnvelope, IStorage } from "../../../shared/types.ts";
import { htob, btoh, concat } from "../../../shared/lib.ts";
import libsodiumCrypto from "../crypto.ts";

const db = new DB("diplomatic.db");
db.query(`
  CREATE TABLE IF NOT EXISTS users (
    pubKey TEXT PRIMARY KEY
  );
`);
db.query(`
  CREATE TABLE IF NOT EXISTS envelopes (
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

  async setEnvelope(pubKey, recordedAt, env, sha256) {
    const pubKeyHex = btoh(pubKey);
    const recAtStr = recordedAt.toISOString();
    const headCph = concat(concat(env.sig, env.kdm), env.headCph);
    const bodyCph = env.bodyCph;
    db.query(
      "INSERT INTO envelopes (sha256, userPubKey, recordedAt, headCph, bodyCph) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      [sha256, pubKeyHex, recAtStr, headCph, bodyCph],
    );
  },

  async getBody(pubKey, sha256) {
    const pubKeyHex = btoh(pubKey);
    const rows = db.query<[Uint8Array]>(
      "SELECT bodyCph FROM envelopes WHERE userPubKey = ? AND sha256 = ?",
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
      "SELECT sha256, recordedAt, headCph FROM envelopes WHERE userPubKey = ? AND recordedAt >= ? AND recordedAt < ?",
      [pubKeyHex, begin, end],
    );
    return rows.map(([sha256, recordedAt, headCph]) => ({
      sha256: sha256,
      recordedAt: new Date(recordedAt),
      headCph: new Uint8Array(headCph),
    }));
  },
};

export default sqliteStorage;
