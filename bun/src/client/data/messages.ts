// Message archive in the protocol SQLite file.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Status } from "../../../../web/src/shared/consts.ts";
import type {
  EntityID,
  Hash,
  ICrypto,
} from "../../../../web/src/shared/types.ts";
import {
  APLD_APPLIED,
  APLD_ERROR,
  APLD_PENDING,
  type ApldState,
  type IMessageStore,
  type IStorableMessage,
  type IStoredMessage,
  type IStoredMessageData,
  type IStoredMessageWrite,
  type ListMsgsOpts,
  toStoredMessage,
} from "../../../../web/src/types.ts";
import { realmLabel } from "../../../../web/src/stores/realm.ts";
import { blobName, dropBlobs, readBlob, writeBlob } from "../blobs.ts";
import { readEID, readHash } from "../brand.ts";
import { blob, countOf, num, row, rows, run, str } from "../sql.ts";

// dataBlobKeys lists spilled body file names in a data file.
// dataBlobKeys does not create the file when it is missing.
export function dataBlobKeys(path: string): string[] {
  if (!existsSync(path)) return [];
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return [];
  }
  try {
    const out: string[] = [];
    for (
      const item of rows(
        db,
        "SELECT body_key FROM messages WHERE body_key IS NOT NULL",
      )
    ) {
      const name = str(item, "body_key");
      if (name !== undefined) out.push(name);
    }
    return out;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function apldNum(apld: ApldState): number {
  if (apld === APLD_APPLIED) return 1;
  if (apld === APLD_ERROR) return 2;
  return 0;
}

function apldOf(n: number | undefined): ApldState {
  if (n === 1) return APLD_APPLIED;
  if (n === 2) return APLD_ERROR;
  return APLD_PENDING;
}

const msgCols = "hash, eid, off, ctr, typ, body, body_key, apld, err, rlm";

type Staged = {
  i: number;
  key: Hash;
  data: IStoredMessageWrite;
  spill?: string;
};

export class SqlMessages implements IMessageStore {
  constructor(
    private db: Database,
    private crypto: ICrypto,
    private blobs: string,
    private maxInlineBytes: number,
  ) {}

  // add stores each message. A body over maxInlineBytes is a file named by its hash.
  async add(messages: IStorableMessage[]): Promise<Status[]> {
    if (messages.length === 0) return [];
    const stats: Status[] = new Array(messages.length).fill(Status.Success);
    const staged: Staged[] = [];
    const fresh: string[] = [];
    try {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg === undefined) {
          stats[i] = Status.InvalidParam;
          continue;
        }
        const name = blobName(msg.key);
        if (name === undefined) {
          stats[i] = Status.InvalidParam;
          continue;
        }
        const body = msg.data.body;
        if (body !== undefined && body.byteLength > this.maxInlineBytes) {
          const path = join(this.blobs, name);
          const existed = existsSync(path);
          const [, st] = await writeBlob(this.blobs, name, body);
          if (st !== Status.Success) {
            stats[i] = st;
            continue;
          }
          if (!existed) fresh.push(name);
          staged.push({ i, key: msg.key, data: msg.data, spill: name });
          continue;
        }
        staged.push({ i, key: msg.key, data: msg.data });
      }
      if (staged.length === 0) return stats;
      this.db.transaction(() => {
        for (const item of staged) this.#put(item);
      })();
      await dropBlobs(this.blobs, inlineNames(staged));
      return stats;
    } catch {
      await dropBlobs(this.blobs, fresh);
      for (let i = 0; i < stats.length; i++) {
        if (stats[i] === Status.Success) stats[i] = Status.DatabaseError;
      }
      return stats;
    }
  }

  async get(key: Hash): Promise<IStoredMessage | undefined> {
    const item = row(
      this.db,
      `SELECT ${msgCols} FROM messages WHERE hash = ?`,
      key,
    );
    if (item === undefined) return undefined;
    return this.#stored(key, item, true);
  }

  async has(key: Hash): Promise<boolean> {
    const item = row(
      this.db,
      "SELECT 1 AS n FROM messages WHERE hash = ?",
      key,
    );
    return item !== undefined;
  }

  async del(keys: Iterable<Hash>) {
    const hashes = [...keys];
    if (hashes.length === 0) return;
    const names: string[] = [];
    this.db.transaction(() => {
      for (const hash of hashes) {
        const item = row(
          this.db,
          "SELECT body_key FROM messages WHERE hash = ?",
          hash,
        );
        const name = item === undefined ? undefined : str(item, "body_key");
        if (name !== undefined) names.push(name);
        run(this.db, "DELETE FROM messages WHERE hash = ?", hash);
      }
    })();
    await dropBlobs(this.blobs, names);
  }

  async list(opts?: ListMsgsOpts): Promise<IStoredMessage[]> {
    const includeBody = opts?.body !== false;
    const items = opts?.apld === undefined
      ? rows(this.db, `SELECT ${msgCols} FROM messages`)
      : rows(
        this.db,
        `SELECT ${msgCols} FROM messages WHERE apld = ?`,
        apldNum(opts.apld),
      );
    const out: IStoredMessage[] = [];
    for (const item of items) {
      const bytes = blob(item, "hash");
      if (bytes === undefined) continue;
      const hash = readHash(bytes);
      if (hash === undefined) continue;
      const stored = await this.#stored(hash, item, includeBody);
      if (stored !== undefined) out.push(stored);
    }
    return out;
  }

  async count(apld?: ApldState): Promise<number> {
    if (apld === undefined) {
      return countOf(this.db, "SELECT COUNT(*) AS n FROM messages");
    }
    return countOf(
      this.db,
      "SELECT COUNT(*) AS n FROM messages WHERE apld = ?",
      apldNum(apld),
    );
  }

  async listKeys(): Promise<Hash[]> {
    const out: Hash[] = [];
    for (const item of rows(this.db, "SELECT hash FROM messages")) {
      const bytes = blob(item, "hash");
      if (bytes === undefined) continue;
      const hash = readHash(bytes);
      if (hash !== undefined) out.push(hash);
    }
    return out;
  }

  // last returns the message for eid with the highest ctr, then off.
  async last(eid: EntityID): Promise<IStoredMessage | undefined> {
    const item = row(
      this.db,
      `SELECT ${msgCols} FROM messages WHERE eid = ?
       ORDER BY COALESCE(ctr, 0) DESC, COALESCE(off, 0) DESC
       LIMIT 1`,
      eid,
    );
    if (item === undefined) return undefined;
    const bytes = blob(item, "hash");
    if (bytes === undefined) return undefined;
    const hash = readHash(bytes);
    if (hash === undefined) return undefined;
    return this.#stored(hash, item, true);
  }

  async markApplied(keys: Iterable<Hash>) {
    const hashes = [...keys];
    if (hashes.length === 0) return;
    this.db.transaction(() => {
      for (const hash of hashes) {
        run(
          this.db,
          "UPDATE messages SET apld = ?, err = NULL WHERE hash = ?",
          apldNum(APLD_APPLIED),
          hash,
        );
      }
    })();
  }

  async markFailed(entries: Iterable<{ key: Hash; err: Status }>) {
    const list = [...entries];
    if (list.length === 0) return;
    this.db.transaction(() => {
      for (const entry of list) {
        run(
          this.db,
          "UPDATE messages SET apld = ?, err = ? WHERE hash = ?",
          apldNum(APLD_ERROR),
          entry.err,
          entry.key,
        );
      }
    })();
  }

  async wipe() {
    const names: string[] = [];
    this.db.transaction(() => {
      for (
        const item of rows(
          this.db,
          "SELECT body_key FROM messages WHERE body_key IS NOT NULL",
        )
      ) {
        const name = str(item, "body_key");
        if (name !== undefined) names.push(name);
      }
      this.db.exec("DELETE FROM messages");
    })();
    await dropBlobs(this.blobs, names);
  }

  #put(item: Staged) {
    const data = item.data;
    const typ = data.typ !== undefined && data.typ !== "" ? data.typ : null;
    const rlm = realmLabel(data.rlm) ?? null;
    const errN = data.apld === APLD_ERROR && data.err !== undefined
      ? data.err
      : null;
    const inline = item.spill === undefined ? data.body ?? null : null;
    run(
      this.db,
      `INSERT INTO messages (
         hash, eid, off, ctr, typ, body, body_key, apld, err, rlm
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
         eid = excluded.eid, off = excluded.off, ctr = excluded.ctr,
         typ = excluded.typ, body = excluded.body, body_key = excluded.body_key,
         apld = excluded.apld, err = excluded.err, rlm = excluded.rlm`,
      item.key,
      data.eid,
      data.off ?? null,
      data.ctr ?? null,
      typ,
      inline,
      item.spill ?? null,
      apldNum(data.apld),
      errN,
      rlm,
    );
  }

  // #stored loads a spill file so the head length matches the body.
  async #stored(
    key: Hash,
    item: Record<string, unknown>,
    includeBody: boolean,
  ): Promise<IStoredMessage | undefined> {
    const data = await this.#data(item);
    if (data === undefined) return undefined;
    return toStoredMessage(key, data, this.crypto, { body: includeBody });
  }

  async #data(
    item: Record<string, unknown>,
  ): Promise<IStoredMessageData | undefined> {
    const eidBytes = blob(item, "eid");
    if (eidBytes === undefined) return undefined;
    const eid = readEID(eidBytes);
    if (eid === undefined) return undefined;
    const data: IStoredMessageData = {
      eid,
      apld: apldOf(num(item, "apld")),
    };
    const off = num(item, "off");
    const ctr = num(item, "ctr");
    const typ = str(item, "typ");
    const rlm = realmLabel(str(item, "rlm"));
    if (off !== undefined) data.off = off;
    if (ctr !== undefined) data.ctr = ctr;
    if (typ !== undefined && typ !== "") data.typ = typ;
    if (rlm !== undefined) data.rlm = rlm;
    if (data.apld === APLD_ERROR) {
      const code = num(item, "err");
      if (code !== undefined) data.err = code;
    }
    let body = blob(item, "body");
    if (body === undefined) {
      const name = str(item, "body_key");
      if (name !== undefined) {
        const [got, st] = await readBlob(this.blobs, name);
        if (st === Status.Success && got !== undefined) body = got;
      }
    }
    if (body !== undefined) data.body = body;
    return data;
  }
}

// inlineNames are spill files replaced by an inline body in this batch.
function inlineNames(staged: Staged[]): string[] {
  const drop = new Set<string>();
  const keep = new Set<string>();
  for (const item of staged) {
    const name = item.spill ?? blobName(item.key);
    if (name === undefined) continue;
    if (item.spill !== undefined) {
      drop.delete(name);
      keep.add(name);
      continue;
    }
    keep.delete(name);
    drop.add(name);
  }
  return [...drop];
}
