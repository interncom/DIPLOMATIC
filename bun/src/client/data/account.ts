// Account catalog in meta.sqlite. A row stores a key tag, not the seed.

import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { Status } from "../../../../web/src/shared/consts.ts";
import type { Enclave } from "../../../../web/src/shared/crypto/enclave.ts";
import type { ICrypto } from "../../../../web/src/shared/types.ts";
import { err, ok, type ValStat } from "../../../../web/src/shared/valstat.ts";
import type { IAccountStore, SetSeedOpts } from "../../../../web/src/types.ts";
import {
  decodeKeyTag,
  type KeyTag,
} from "../../../../web/src/stores/keyTag.ts";
import {
  keyTagMatches,
  makeKeyTag,
} from "../../../../web/src/stores/keyTag.ts";
import { accountLabel } from "../../../../web/src/stores/label.ts";
import {
  assignEnts,
  placeAccount,
} from "../../../../web/src/stores/idb/names.ts";
import { dropBlobs } from "../blobs.ts";
import { dataBlobKeys } from "./messages.ts";
import { blobsDir, dataPath, entsPath, rmDB } from "../dir.ts";
import { blob, row, rows, run, str } from "../sql.ts";

// keyring is reserved for a later YubiKey bind (tools/keys).
// save writes nonce and fingerprint and copies keyring through
// so a save cannot clear it.
const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  label TEXT PRIMARY KEY,
  acct TEXT,
  data TEXT,
  ents TEXT,
  nonce BLOB,
  fingerprint BLOB,
  keyring BLOB
);
`;

type Acct = {
  label: string;
  acct?: string;
  data?: string;
  ents?: string;
  nonce?: Uint8Array;
  fingerprint?: Uint8Array;
  keyring?: Uint8Array;
};

// tagOf reads nonce and fingerprint.
// Both absent is no tag yet. A half-written or short tag is DatabaseError.
function tagOf(
  nonce: Uint8Array | undefined,
  fingerprint: Uint8Array | undefined,
): ValStat<KeyTag | undefined> {
  if (nonce === undefined && fingerprint === undefined) return ok(undefined);
  if (nonce === undefined || fingerprint === undefined) {
    return err(Status.DatabaseError);
  }
  const tag = decodeKeyTag({ n: nonce, h: fingerprint });
  if (tag === undefined) return err(Status.DatabaseError);
  return ok(tag);
}

function readAcct(item: Record<string, unknown>): Acct | undefined {
  const label = str(item, "label");
  if (label === undefined) return undefined;
  const acct: Acct = { label };
  const id = str(item, "acct");
  const data = str(item, "data");
  const ents = str(item, "ents");
  const nonce = blob(item, "nonce");
  const fingerprint = blob(item, "fingerprint");
  const keyring = blob(item, "keyring");
  if (id !== undefined && id !== "") acct.acct = id;
  if (data !== undefined && data !== "") acct.data = data;
  if (ents !== undefined && ents !== "") acct.ents = ents;
  if (nonce !== undefined) acct.nonce = nonce;
  if (fingerprint !== undefined) acct.fingerprint = fingerprint;
  if (keyring !== undefined) acct.keyring = keyring;
  return acct;
}

export class SqliteAccountStore implements IAccountStore {
  #close: (() => void) | undefined;

  constructor(
    private db: Database,
    private crypto: ICrypto,
    private dir: string,
  ) {
    this.db.exec(schema);
  }

  // setCloser runs before wipe unlinks data and ents files.
  setCloser(close: () => void) {
    this.#close = close;
  }

  // close releases the catalog connection.
  close() {
    this.db.close();
  }

  // save records the key tag for opts.label. It does not store the seed.
  // A later save of a different master is HashMismatch. opts.persist is ignored.
  async save(
    enclave: Enclave,
    opts?: SetSeedOpts,
  ): Promise<ValStat<Enclave>> {
    const [label, lst] = accountLabel(opts?.label);
    if (lst !== Status.Success || label === undefined) {
      return err(Status.InvalidParam);
    }

    // Reject a corrupt tag. Do not replace it.
    const cur = this.#read(label);
    const [tag, tst] = tagOf(cur?.nonce, cur?.fingerprint);
    if (tst !== Status.Success) return err(tst);
    if (tag !== undefined) {
      const hit = await keyTagMatches(enclave, tag);
      if (!hit) return err(Status.HashMismatch);
      return ok(enclave);
    }

    // Mint the tag before taking the write lock.
    const [made, mst] = await makeKeyTag(this.crypto, enclave);
    if (mst !== Status.Success) return err(mst);
    if (made === undefined) return err(Status.InternalError);

    // Re-read under the lock so a concurrent writer is not overwritten.
    const raced: ValStat<KeyTag>[] = [];
    try {
      this.db.transaction(() => {
        const again = this.#read(label);
        const [now, nst] = tagOf(again?.nonce, again?.fingerprint);
        if (nst !== Status.Success) {
          raced.push(err(nst));
          return;
        }
        if (now !== undefined) {
          raced.push(ok(now));
          return;
        }
        const placed = placeAccount(again?.acct, again?.data);
        this.#put({
          label,
          acct: placed.acct,
          data: placed.data,
          ents: again?.ents,
          nonce: made.n,
          fingerprint: made.h,
          keyring: again?.keyring,
        });
      }).immediate();
    } catch {
      return err(Status.DatabaseError);
    }
    const won = raced[0];
    if (won !== undefined) {
      const [held, hst] = won;
      if (hst !== Status.Success) return err(hst);
      const hit = await keyTagMatches(enclave, held);
      if (!hit) return err(Status.HashMismatch);
    }
    return ok(enclave);
  }

  // dataName is the protocol file name for label, when that account exists.
  async dataName(label: string): Promise<string | undefined> {
    const cur = this.#read(label);
    if (cur === undefined) return undefined;
    if (cur.data !== undefined) return cur.data;
    let data = "";
    this.db.transaction(() => {
      const again = this.#read(label);
      if (again === undefined) return;
      if (again.data !== undefined) {
        data = again.data;
        return;
      }
      const placed = placeAccount(again.acct, again.data);
      data = placed.data;
      this.#put({ ...again, acct: placed.acct, data: placed.data });
    }).immediate();
    return data === "" ? undefined : data;
  }

  // ensureEnts fills the ents file name, creating the catalog row if needed.
  async ensureEnts(label: string): Promise<ValStat<string>> {
    const [name, lst] = accountLabel(label);
    if (lst !== Status.Success || name === undefined) {
      return err(Status.InvalidParam);
    }
    let ents = "";
    try {
      this.db.transaction(() => {
        const cur = this.#read(name);
        const placed = placeAccount(cur?.acct, cur?.data);
        const next = assignEnts(placed.acct, cur?.ents);
        ents = next;
        this.#put({
          label: name,
          acct: placed.acct,
          data: placed.data,
          ents: next,
          nonce: cur?.nonce,
          fingerprint: cur?.fingerprint,
          keyring: cur?.keyring,
        });
      }).immediate();
    } catch {
      return err(Status.DatabaseError);
    }
    if (ents === "") return err(Status.DatabaseError);
    return ok(ents);
  }

  // wipe deletes every account's data file, ents file, and spilled bodies.
  async wipe() {
    const list = this.#list();
    const names: string[] = [];
    for (const row of list) {
      if (row.data === undefined) continue;
      const path = dataPath(this.dir, row.data);
      if (path === undefined || !existsSync(path)) continue;
      names.push(...dataBlobKeys(path));
    }

    // Close open databases before unlinking them.
    this.#close?.();
    for (const row of list) {
      if (row.data !== undefined) {
        const path = dataPath(this.dir, row.data);
        if (path !== undefined) rmDB(path);
      }
      if (row.ents !== undefined) {
        const path = entsPath(this.dir, row.ents);
        if (path !== undefined) rmDB(path);
      }
    }
    await dropBlobs(blobsDir(this.dir), names);
    run(this.db, "DELETE FROM accounts");
  }

  #read(label: string): Acct | undefined {
    const item = row(
      this.db,
      "SELECT label, acct, data, ents, nonce, fingerprint, keyring FROM accounts WHERE label = ?",
      label,
    );
    if (item === undefined) return undefined;
    return readAcct(item);
  }

  #list(): Acct[] {
    const out: Acct[] = [];
    for (
      const item of rows(
        this.db,
        "SELECT label, acct, data, ents, nonce, fingerprint, keyring FROM accounts",
      )
    ) {
      const acct = readAcct(item);
      if (acct !== undefined) out.push(acct);
    }
    return out;
  }

  #put(row: Acct) {
    run(
      this.db,
      `INSERT INTO accounts (label, acct, data, ents, nonce, fingerprint, keyring)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET
         acct = excluded.acct,
         data = excluded.data,
         ents = excluded.ents,
         nonce = excluded.nonce,
         fingerprint = excluded.fingerprint,
         keyring = excluded.keyring`,
      row.label,
      row.acct ?? null,
      row.data ?? null,
      row.ents ?? null,
      row.nonce ?? null,
      row.fingerprint ?? null,
      row.keyring ?? null,
    );
  }
}
