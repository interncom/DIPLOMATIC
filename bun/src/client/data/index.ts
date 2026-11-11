// Opens the protocol tables in one data-<acct>.sqlite file.

import type { Database } from "bun:sqlite";
import { maxInlineBodyBytes } from "../../../../web/src/shared/bodykey.ts";
import type { ICrypto } from "../../../../web/src/shared/types.ts";
import type {
  IDownloadQueue,
  IHostStore,
  IMessageStore,
  IUploadQueue,
} from "../../../../web/src/types.ts";
import type { IRealmStore } from "../../../../web/src/stores/realm.ts";
import { SqlDownloads } from "./downloads.ts";
import { SqlHosts } from "./hosts.ts";
import { SqlMessages } from "./messages.ts";
import { SqlRealms } from "./realms.ts";
import { SqlUploads } from "./uploads.ts";

const schema = `
CREATE TABLE IF NOT EXISTS hosts (
  label TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  idx INTEGER,
  clock_off INTEGER,
  sub TEXT
);
CREATE TABLE IF NOT EXISTS host_seqs (
  host TEXT NOT NULL,
  label TEXT NOT NULL,
  idx INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (host, label, idx)
);
CREATE TABLE IF NOT EXISTS uploads (
  host TEXT NOT NULL,
  hash BLOB NOT NULL,
  PRIMARY KEY (host, hash)
);
CREATE TABLE IF NOT EXISTS downloads (
  host TEXT NOT NULL,
  rlabel TEXT NOT NULL,
  ridx INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kdm BLOB NOT NULL,
  eid BLOB NOT NULL,
  off INTEGER,
  ctr INTEGER,
  typ TEXT,
  len INTEGER NOT NULL,
  hsh BLOB,
  head_enc BLOB,
  head_enc_hash BLOB,
  PRIMARY KEY (host, rlabel, ridx, seq)
);
CREATE TABLE IF NOT EXISTS messages (
  hash BLOB PRIMARY KEY,
  eid BLOB NOT NULL,
  off INTEGER,
  ctr INTEGER,
  typ TEXT,
  body BLOB,
  body_key TEXT,
  apld INTEGER NOT NULL DEFAULT 0,
  err INTEGER,
  rlm TEXT
);
CREATE INDEX IF NOT EXISTS messages_eid ON messages(eid);
CREATE INDEX IF NOT EXISTS messages_apld ON messages(apld);
CREATE TABLE IF NOT EXISTS realms (
  label TEXT PRIMARY KEY,
  idx INTEGER NOT NULL,
  prior TEXT
);
`;

export type DataTables = {
  realms: IRealmStore;
  hosts: IHostStore<URL>;
  uploads: IUploadQueue;
  downloads: IDownloadQueue;
  messages: IMessageStore;
};

// ensureData creates the protocol tables.
export function ensureData(db: Database) {
  db.exec(schema);
}

// openDataTables opens the protocol stores on one data file.
export function openDataTables(
  db: Database,
  crypto: ICrypto,
  blobs: string,
  maxInlineBytes = maxInlineBodyBytes,
): DataTables {
  ensureData(db);
  return {
    realms: new SqlRealms(db),
    hosts: new SqlHosts(db),
    uploads: new SqlUploads(db),
    downloads: new SqlDownloads(db),
    messages: new SqlMessages(db, crypto, blobs, maxInlineBytes),
  };
}
