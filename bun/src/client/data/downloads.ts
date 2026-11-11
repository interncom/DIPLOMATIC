// Download queue in the protocol SQLite file.

import type { Database } from "bun:sqlite";
import type { IKDM } from "../../../../web/src/shared/codecs/kdm.ts";
import { nullKDM } from "../../../../web/src/shared/crypto/derivation.ts";
import type { IMessageHead } from "../../../../web/src/shared/types.ts";
import type {
  IDownloadMessage,
  IDownloadQueue,
} from "../../../../web/src/types.ts";
import { isDefaultRealm } from "../../../../web/src/stores/cursor.ts";
import { readEID, readHash } from "../brand.ts";
import { blob, countOf, num, rows, run, str } from "../sql.ts";

function realmParts(realm?: IKDM): { label: string; index: number } {
  const r = realm ?? nullKDM;
  return { label: r.label, index: r.index };
}

function downloadFrom(
  item: Record<string, unknown>,
): IDownloadMessage | undefined {
  const host = str(item, "host");
  const seq = num(item, "seq");
  const kdm = blob(item, "kdm");
  const eidBytes = blob(item, "eid");
  if (
    host === undefined || seq === undefined || kdm === undefined ||
    eidBytes === undefined
  ) {
    return undefined;
  }
  const eid = readEID(eidBytes);
  if (eid === undefined) return undefined;
  const head: IMessageHead = {
    eid,
    off: num(item, "off") ?? 0,
    ctr: num(item, "ctr") ?? 0,
    len: num(item, "len") ?? 0,
  };
  const typ = str(item, "typ");
  if (typ !== undefined && typ !== "") head.typ = typ;
  const hsh = blob(item, "hsh");
  if (hsh !== undefined) head.hsh = hsh;
  const msg: IDownloadMessage = { host, seq, kdm, head };
  const rlabel = str(item, "rlabel") ?? "";
  const ridx = num(item, "ridx") ?? 0;
  if (!isDefaultRealm({ label: rlabel, index: ridx })) {
    msg.realm = { label: rlabel, index: ridx };
  }
  const headEnc = blob(item, "head_enc");
  if (headEnc !== undefined) msg.headEnc = headEnc;
  const headEncHash = blob(item, "head_enc_hash");
  if (headEncHash !== undefined) {
    const hash = readHash(headEncHash);
    if (hash !== undefined) msg.headEncHash = hash;
  }
  return msg;
}

export class SqlDownloads implements IDownloadQueue {
  constructor(private db: Database) {}

  async enq(msgs: Iterable<IDownloadMessage>) {
    const list = [...msgs];
    if (list.length === 0) return;
    this.db.transaction(() => {
      for (const msg of list) {
        const realm = realmParts(msg.realm);
        const typ = msg.head.typ !== undefined && msg.head.typ !== ""
          ? msg.head.typ
          : null;
        run(
          this.db,
          `INSERT INTO downloads (
             host, rlabel, ridx, seq, kdm, eid, off, ctr, typ, len, hsh,
             head_enc, head_enc_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host, rlabel, ridx, seq) DO UPDATE SET
             kdm = excluded.kdm, eid = excluded.eid, off = excluded.off,
             ctr = excluded.ctr, typ = excluded.typ, len = excluded.len,
             hsh = excluded.hsh, head_enc = excluded.head_enc,
             head_enc_hash = excluded.head_enc_hash`,
          msg.host,
          realm.label,
          realm.index,
          msg.seq,
          msg.kdm,
          msg.head.eid,
          msg.head.off,
          msg.head.ctr,
          typ,
          msg.head.len,
          msg.head.hsh ?? null,
          msg.headEnc ?? null,
          msg.headEncHash ?? null,
        );
      }
    })();
  }

  async deq(host: string, seqs: Iterable<number>, realm?: IKDM) {
    const list = [...seqs];
    if (list.length === 0) return;
    const parts = realmParts(realm);
    this.db.transaction(() => {
      for (const seq of list) {
        run(
          this.db,
          "DELETE FROM downloads WHERE host = ? AND rlabel = ? AND ridx = ? AND seq = ?",
          host,
          parts.label,
          parts.index,
          seq,
        );
      }
    })();
  }

  async list(): Promise<IDownloadMessage[]> {
    const out: IDownloadMessage[] = [];
    for (
      const item of rows(
        this.db,
        `SELECT host, rlabel, ridx, seq, kdm, eid, off, ctr, typ, len, hsh,
                head_enc, head_enc_hash
         FROM downloads`,
      )
    ) {
      const msg = downloadFrom(item);
      if (msg !== undefined) out.push(msg);
    }
    return out;
  }

  async count(): Promise<number> {
    return countOf(this.db, "SELECT COUNT(*) AS n FROM downloads");
  }

  async wipe() {
    run(this.db, "DELETE FROM downloads");
  }
}
