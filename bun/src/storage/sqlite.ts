import { Database } from "bun:sqlite";
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
      ).get(pubKeyHex) as { "EXISTS (SELECT 1 FROM users WHERE pubKey = ?)": number };
      const has = row ? row["EXISTS (SELECT 1 FROM users WHERE pubKey = ?)"] : false;
      return ok(Boolean(has));
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
      const row = db.prepare("SELECT MAX(seq) FROM bags WHERE userPubKey = ?")
        .get(pubKeyHex) as { "MAX(seq)": number | null };
      const maxSeq = row ? row["MAX(seq)"] || 0 : 0;
      const seq = maxSeq + 1;
      const enc = new Encoder();
      enc.writeStruct(peekItemHeadCodec, bag);
      const headCph = enc.result();
      const bodyCph = bag.bodyCph;
      db.exec(
        "INSERT INTO bags (userPubKey, seq, headCph, bodyCph) VALUES (?, ?, ?, ?)",
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
        "SELECT bodyCph FROM bags WHERE userPubKey = ? AND seq = ?",
      ).get(pubKeyHex, seq) as { bodyCph: Uint8Array } | undefined;
      if (!row) {
        return ok(undefined);
      }
      return ok(new Uint8Array(row.bodyCph));
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

export default sqliteStorage;