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
  CREATE TABLE IF NOT EXISTS ops (
    userPubKey TEXT,
    recordedAt TEXT,
    sha256 BLOB,
    op BLOB,
    size INT,
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

  async setOp(
    pubKeyHex: string,
    recordedAt: Date,
    op: Uint8Array,
    key?: string,
  ) {
    const recAtStr = recordedAt.toISOString();
    const sha256 = key ? htob(key) : await libsodiumCrypto.sha256Hash(op);
    db.query(
      "INSERT INTO ops (sha256, userPubKey, recordedAt, op, size) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      [sha256, pubKeyHex, recAtStr, op, op.byteLength],
    );
  },

  async getOp(pubKeyHex: string, sha256Hex: string) {
    const sha256 = htob(sha256Hex);
    const rows = db.query<[Uint8Array, number]>(
      "SELECT op, size FROM ops WHERE userPubKey = ? AND sha256 = ?",
      [pubKeyHex, sha256],
    );
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const [rawOp, size] = row;
    const op = new Uint8Array(rawOp);
    return op.subarray(0, size);
  },

  async listOps(pubKeyHex: string, begin: string, end: string) {
    const rows = db.query<[Uint8Array, string]>(
      "SELECT sha256, recordedAt FROM ops WHERE userPubKey = ? AND recordedAt >= ? AND recordedAt < ?",
      [pubKeyHex, begin, end],
    );
    return rows.map(([sha256, recordedAt]) => ({
      sha256: sha256,
      recordedAt: new Date(recordedAt),
    }));
  },
};

export default sqliteStorage;
