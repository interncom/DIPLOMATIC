import { DB } from "https://deno.land/x/sqlite/mod.ts";
import { IStorage } from "../../../shared/types.ts";
import { htob } from "../../../shared/lib.ts";
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
      headCry BLOB,
      bodyCry BLOB,
      PRIMARY KEY (userPubKey, sha256)
    );
`);

const sqliteStorage: IStorage = {
  async addUser(pubKeyHex: string) {
    db.query("INSERT INTO users (pubKey) VALUES (?) ON CONFLICT DO NOTHING", [
      pubKeyHex,
    ]);
  },

  async hasUser(pubKeyHex: string) {
    const rows = db.query<[boolean]>(
      "SELECT EXISTS (SELECT 1 FROM users WHERE pubKey = ?)",
      [pubKeyHex],
    );
    const row = rows?.[0];
    const has = row?.[0];
    return has ?? false;
  },

  async setEnvelope(
    pubKeyHex: string,
    recordedAt: Date,
    headCry: Uint8Array,
    bodyCry: Uint8Array,
    sha256Hex: string,
  ) {
    const recAtStr = recordedAt.toISOString();
    const sha256 = htob(sha256Hex);
    db.query(
      "INSERT INTO envelopes (sha256, userPubKey, recordedAt, headCry, bodyCry) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      [sha256, pubKeyHex, recAtStr, headCry, bodyCry],
    );
  },

  async getBody(pubKeyHex: string, sha256Hex: string) {
    const sha256 = htob(sha256Hex);
    const rows = db.query<[Uint8Array]>(
      "SELECT bodyCry FROM envelopes WHERE userPubKey = ? AND sha256 = ?",
      [pubKeyHex, sha256],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return new Uint8Array(row[0]);
  },

  async listHeads(pubKeyHex: string, begin: string, end: string) {
    const rows = db.query<[Uint8Array, string, Uint8Array]>(
      "SELECT sha256, recordedAt, headCry FROM envelopes WHERE userPubKey = ? AND recordedAt >= ? AND recordedAt < ?",
      [pubKeyHex, begin, end],
    );
    return rows.map(([sha256, recordedAt, headCry]) => ({
      sha256: sha256,
      recordedAt: new Date(recordedAt),
      headCry: new Uint8Array(headCry),
    }));
  },
};

export default sqliteStorage;
