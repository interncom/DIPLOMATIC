// SQLite bag store. Large bodies are files beside the database.

import { Database } from "bun:sqlite";
import { btoh } from "../../../shared/binary.ts";
import { dropBodyFiles, readBodyFile, writeBodyFile } from "./blobfile.ts";
import { maxInlineBodyBytes, newBodyKey } from "../../../shared/bodykey.ts";
import { Encoder } from "../../../shared/codec.ts";
import { peekItemHeadCodec } from "../../../shared/codecs/peekItemHead.ts";
import { hashBytes, Status } from "../../../shared/consts.ts";
import type { ISetBagResult, IStorage } from "../../../shared/types.ts";
import { nullSubMeta } from "../../../shared/types.ts";
import { err, ok } from "../../../shared/valstat.ts";

// Slot is one bag that will get a row.
// Slot stores a null body when the ciphertext is a file.
type Slot = {
  i: number;
  body: Uint8Array | null;
  key: string | null;
};

// createSqliteStorage opens a WAL SQLite store.
// createSqliteStorage defaults path to ./diplomatic.db. Bodies over maxInlineBodyBytes are files under `${path}.blobs/`.
export function createSqliteStorage(path = "diplomatic.db"): IStorage {
  const db = new Database(path);
  const blobDir = `${path}.blobs`;
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
      bodyKey TEXT,
      PRIMARY KEY (userPubKey, rlm, seq)
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

    // setBags stores bags. A failed external body is StorageError for that bag and is not inserted.
    async setBags(pubKey, bags) {
      if (bags.length < 1) return ok([]);
      // A bad rlm is skipped here and reported InvalidParam below.
      const good: number[] = [];
      for (let i = 0; i < bags.length; i++) {
        if (bags[i].rlm.byteLength === hashBytes) good.push(i);
      }
      const seqByIdx = new Map<number, number>();
      const blobErr = new Set<number>();
      if (good.length > 0) {
        const pubKeyHex = btoh(pubKey);
        // slots are the bags that will get a row. A failed file write is left out.
        const slots: Slot[] = [];
        const wrote: string[] = [];
        for (const i of good) {
          const bag = bags[i];
          // File first. A failed write skips the row and does not take a seq.
          if (bag.bodyCph.byteLength > maxInlineBodyBytes) {
            const key = newBodyKey(pubKeyHex, bag.rlm);
            const [, wst] = await writeBodyFile(blobDir, key, bag.bodyCph);
            if (wst !== Status.Success) {
              await dropBodyFiles(blobDir, [key]);
              blobErr.add(i);
              continue;
            }
            wrote.push(key);
            slots.push({ i, body: null, key });
          } else {
            slots.push({ i, body: bag.bodyCph, key: null });
          }
        }
        if (slots.length > 0) {
          // IMMEDIATE: take write lock before read so concurrent setBags
          // cannot both observe the same MAX(seq) within an rlm.
          let failed = false;
          try {
            db.exec("BEGIN IMMEDIATE");
            const maxBy = new Map<string, number>();
            const maxStmt = db.prepare(
              "SELECT MAX(seq) AS m FROM bags WHERE userPubKey = ? AND rlm = ?",
            );
            const insert = db.prepare(
              "INSERT INTO bags (userPubKey, rlm, seq, headCph, bodyCph, bodyKey) VALUES (?, ?, ?, ?, ?, ?)",
            );
            for (const slot of slots) {
              const bag = bags[slot.i];
              const key = btoh(bag.rlm);
              let max = maxBy.get(key);
              if (max === undefined) {
                const row = maxStmt.get(pubKeyHex, bag.rlm) as {
                  m: number | null;
                };
                max = row?.m || 0;
              }
              max += 1;
              maxBy.set(key, max);
              const enc = new Encoder();
              enc.writeStruct(peekItemHeadCodec, bag);
              insert.run(
                pubKeyHex,
                bag.rlm,
                max,
                enc.result(),
                slot.body,
                slot.key,
              );
              seqByIdx.set(slot.i, max);
            }
            db.exec("COMMIT");
          } catch {
            try {
              db.exec("ROLLBACK");
            } catch {
              // ignore
            }
            failed = true;
          }
          // SQL did not commit. Delete the files written for this call.
          if (failed) {
            await dropBodyFiles(blobDir, wrote);
            return err(Status.StorageError);
          }
        }
      }
      // One result per input bag, in the caller's order.
      const out: ISetBagResult[] = [];
      for (let i = 0; i < bags.length; i++) {
        if (bags[i].rlm.byteLength !== hashBytes) {
          out.push({ status: Status.InvalidParam });
          continue;
        }
        if (blobErr.has(i)) {
          out.push({ status: Status.StorageError });
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
          const raw: unknown = db.prepare(
            `SELECT seq, bodyCph, bodyKey FROM bags WHERE userPubKey = ? AND rlm = ? AND seq IN (${placeholders})`,
          ).all(pubKeyHex, rlm, ...part);
          if (!Array.isArray(raw)) return err(Status.StorageError);
          for (const row of raw) {
            if (typeof row !== "object" || row === null) continue;
            if (!("seq" in row) || typeof row.seq !== "number") continue;
            const bodyKey = "bodyKey" in row ? row.bodyKey : null;
            const bodyCph = "bodyCph" in row ? row.bodyCph : null;
            // bodyKey set: ciphertext is the file, not the column.
            if (typeof bodyKey === "string") {
              const [body, bst] = await readBodyFile(blobDir, bodyKey);
              if (bst !== Status.Success) return err(bst);
              out.push({ seq: row.seq, bodyCph: body });
              continue;
            }
            if (bodyCph instanceof Uint8Array) {
              out.push({ seq: row.seq, bodyCph: new Uint8Array(bodyCph) });
            }
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
        ).all(pubKeyHex, rlm, minSeq) as {
          seq: number;
          headCph: Uint8Array;
        }[];
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
