// One-time copy of a 0.22 browser profile into the realms layout.
// TODO(realms-sunset): delete after that profile has been copied.

import { concat } from "../../shared/binary";
import { checksumSet } from "../../shared/checksum";
import type { IUsageQuota } from "../../shared/codecs/usageQuota";
import { Status } from "../../shared/consts";
import { Enclave } from "../../shared/crypto/enclave";
import { unsealPRF } from "../../shared/crypto/prf";
import { asSealedMasterKey } from "../../shared/seed";
import type {
  Hash,
  ICrypto,
  IHostConnectionInfo,
  IHostMetadata,
  ISubscriptionMetadata,
} from "../../shared/types";
import { err, ok, type ValStat } from "../../shared/valstat";
import {
  checksumEntities,
  ENT_IDB_NAME,
  entityTableName,
  openEntDatabase,
} from "../../entdb/idb";
import { decodeKeyring, type Keyring } from "../../passkey/prf-store";
import { accountLabel } from "../label";
import { IDBAccountStore } from "./account";
import { IDBHostStore } from "./hosts";
import { openAt } from "./idbutil";
import { openDataDB } from "./migrate";
import { IDBMessageStore } from "./msgs";
import { HOSTS_TABLE, MESSAGES_TABLE, openIDBStore } from "./store";

// 0.22 protocol database. Open it only at the version IndexedDB already reports.
const OLD_DATA = "diplomatic-store-db";
const OLD_SEED = "seedMeta";
const OLD_RING = "keyring";

// 0.22 seal key: first 32 bytes of blake3(prf ‖ "diplomatic.bind.v1").
const BIND_DOMAIN = new TextEncoder().encode("diplomatic.bind.v1");
const SEAL_KEY_LEN = 32;
const SEAL_PRF_MIN = 16;

const PAGE = 256;

type Row = { key: IDBValidKey; value: unknown };

type OldHost = {
  info: IHostConnectionInfo<URL>;
  meta?: IHostMetadata;
};

// Counts and checksums from one 0.22 copy. Compare the hashes before any push.
export type Copy022Report = {
  msgs: number;
  ents: number;
  hosts: number;
  oldMsgs: Hash;
  newMsgs: Hash;
  oldEnts: Hash;
  newEnts: Hash;
};

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

// Opens `name` at its current version. A missing database is NotFound.
async function openCurrent(name: string): Promise<ValStat<IDBDatabase>> {
  if (typeof indexedDB === "undefined" || indexedDB.databases === undefined) {
    return err(Status.NotImplemented);
  }
  let infos: IDBDatabaseInfo[];
  try {
    infos = await indexedDB.databases();
  } catch {
    return err(Status.DatabaseError);
  }
  const version = infos.find((row) => row.name === name)?.version;
  if (version === undefined || version < 1) return err(Status.NotFound);
  try {
    return ok(await openAt(name, version, keepVersion));
  } catch {
    return err(Status.DatabaseError);
  }
}

function keepVersion(): void {
  // The requested version is the one already on disk, so this does not run.
}

// Reads the 0.22 keyring out of diplomatic-store-db.
// Does not create that database. The caller runs the passkey ceremony.
export async function read022Keyring(): Promise<ValStat<Keyring>> {
  const [db, st] = await openCurrent(OLD_DATA);
  if (st !== Status.Success) return err(st);
  try {
    if (!db.objectStoreNames.contains(OLD_SEED)) return err(Status.NotFound);
    const raw = await idbGet(db, OLD_SEED, OLD_RING);
    const ring = decodeKeyring(raw);
    if (ring === undefined) return err(Status.NotFound);
    return ok(ring);
  } catch {
    return err(Status.DatabaseError);
  } finally {
    db.close();
  }
}

function idbGet(
  db: IDBDatabase,
  table: string,
  key: IDBValidKey,
): Promise<unknown> {
  const tx = db.transaction(table, "readonly");
  const store = tx.objectStore(table);
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Opens the 0.22 keyring with the passkey and wipes the PRF output.
export async function unlock022(
  crypto: ICrypto,
  opts: { rpId: string; rpName?: string },
): Promise<ValStat<Enclave>> {
  const [ring, rst] = await read022Keyring();
  if (rst !== Status.Success || ring === undefined) return err(rst);
  if (ring.entries.length === 0) return err(Status.MissingSeed);
  const [out, ost] = await unsealPRF(
    ring.entries.map((e) => ({
      sealedMaster: e.sealedMaster,
      credId: e.credId,
      salt: ring.salt,
    })),
    { rpId: opts.rpId, rpName: opts.rpName, salt: ring.salt },
  );
  if (ost !== Status.Success || out === undefined) return err(ost);
  try {
    for (const w of out.order) {
      const [enclave, est] = await unseal022(crypto, w.sealedMaster, out.prf);
      if (est === Status.Success && enclave !== undefined) return ok(enclave);
    }
    return err(Status.DecryptionError);
  } finally {
    out.prf.fill(0);
  }
}

// Unwraps a 0.22 passkey seal into an enclave.
// The caller wipes prf, then bindAndSave so the new seal is what gets stored.
export async function unseal022(
  crypto: ICrypto,
  sealed: Uint8Array,
  prf: Uint8Array,
): Promise<ValStat<Enclave>> {
  if (prf.byteLength < SEAL_PRF_MIN) return err(Status.InvalidParam);
  const [blob, sst] = asSealedMasterKey(sealed);
  if (sst !== Status.Success) return err(sst);
  const mix = concat(prf, BIND_DOMAIN);
  let hash: Uint8Array | undefined;
  let key: Uint8Array | undefined;
  let plain: Uint8Array | undefined;
  try {
    hash = await crypto.blake3(mix);
    key = hash.slice(0, SEAL_KEY_LEN);
    try {
      plain = await crypto.decryptXSalsa20Poly1305Combined(blob, key);
    } catch {
      return err(Status.DecryptionError);
    }
    return Enclave.fromBytes(plain);
  } finally {
    mix.fill(0);
    hash?.fill(0);
    key?.fill(0);
    plain?.fill(0);
  }
}

// Copies messages, entities, and host identity from a 0.22 profile into `label`.
// Leaves diplomatic-store-db and db in place, and leaves host cursors empty.
// Stop the sync worker first, and bindAndSave before the session ends.
// A hash mismatch is still Success; compare the report before any push.
export async function copy022(opts: {
  crypto: ICrypto;
  enclave: Enclave;
  label?: string;
}): Promise<ValStat<Copy022Report>> {
  const [label, lst] = accountLabel(opts.label);
  if (lst !== Status.Success) return err(lst);
  const [oldData, dst] = await openCurrent(OLD_DATA);
  if (dst !== Status.Success) return err(dst);
  const [oldEnts, est] = await openCurrent(ENT_IDB_NAME);
  if (est !== Status.Success) {
    oldData.close();
    return err(est);
  }
  try {
    return await copyInto(opts.crypto, opts.enclave, label, oldData, oldEnts);
  } catch (e) {
    console.error("[DIPLOMATIC] copy022", e);
    return err(Status.DatabaseError);
  } finally {
    oldData.close();
    oldEnts.close();
  }
}

async function copyInto(
  crypto: ICrypto,
  enclave: Enclave,
  label: string,
  oldData: IDBDatabase,
  oldEnts: IDBDatabase,
): Promise<ValStat<Copy022Report>> {
  if (!oldData.objectStoreNames.contains(MESSAGES_TABLE)) {
    return err(Status.NotFound);
  }
  if (!oldData.objectStoreNames.contains(HOSTS_TABLE)) {
    return err(Status.NotFound);
  }
  if (!oldEnts.objectStoreNames.contains(entityTableName)) {
    return err(Status.NotFound);
  }
  const [hosts, hst] = await readHosts(oldData);
  if (hst !== Status.Success) return err(hst);

  const store = await openIDBStore(crypto);
  let fresh: IDBDatabase | undefined;
  let entsDb: IDBDatabase | undefined;
  try {
    if (!(store.account instanceof IDBAccountStore)) {
      return err(Status.InvalidParam);
    }
    const account = store.account;
    const [, sst] = await account.save(enclave, { label });
    if (sst !== Status.Success) return err(sst);
    const bound = await store.bind(label);
    if (bound !== Status.Success) return err(bound);
    const dataName = await account.dataName(label);
    if (dataName === undefined) return err(Status.NotFound);
    fresh = await openDataDB(dataName);
    const [msgs, mst] = await copyTable(
      oldData,
      fresh,
      MESSAGES_TABLE,
      false,
    );
    if (mst !== Status.Success) return err(mst);
    const entsName = await account.ensureEnts(label);
    entsDb = await openEntDatabase(entsName);
    const [ents, nst] = await copyTable(
      oldEnts,
      entsDb,
      entityTableName,
      true,
    );
    if (nst !== Status.Success) return err(nst);
    const written = await writeHosts(fresh, hosts);
    if (written !== Status.Success) return err(written);

    const [oldEntHash, oest] = await checksumEntities(oldEnts, crypto);
    if (oest !== Status.Success) return err(oest);
    const [newEntHash, nest] = await checksumEntities(entsDb, crypto);
    if (nest !== Status.Success) return err(nest);
    const oldMsgs = await msgHash(oldData, crypto);
    const newMsgs = await msgHash(fresh, crypto);
    return ok({
      msgs,
      ents,
      hosts: hosts.length,
      oldMsgs,
      newMsgs,
      oldEnts: oldEntHash,
      newEnts: newEntHash,
    });
  } finally {
    fresh?.close();
    entsDb?.close();
    store.close();
  }
}

async function copyTable(
  src: IDBDatabase,
  dst: IDBDatabase,
  table: string,
  inline: boolean,
): Promise<ValStat<number>> {
  let n = 0;
  let after: IDBValidKey | undefined;
  for (;;) {
    const [rows, st] = await readPage(src, table, after);
    if (st !== Status.Success) return err(st);
    const put = await putRows(dst, table, rows, inline);
    if (put !== Status.Success) return err(put);
    n += rows.length;
    const last = rows[rows.length - 1];
    if (rows.length < PAGE || last === undefined) return ok(n);
    after = last.key;
  }
}

function readPage(
  db: IDBDatabase,
  table: string,
  after: IDBValidKey | undefined,
): Promise<ValStat<Row[]>> {
  const tx = db.transaction(table, "readonly");
  const store = tx.objectStore(table);
  const query = after === undefined
    ? null
    : IDBKeyRange.lowerBound(after, true);
  return new Promise((resolve) => {
    let done = false;
    let keys: IDBValidKey[] | undefined;
    let vals: unknown[] | undefined;
    const fail = () => {
      if (done) return;
      done = true;
      resolve(err(Status.DatabaseError));
    };
    const finish = () => {
      if (done || keys === undefined || vals === undefined) return;
      done = true;
      if (keys.length !== vals.length) {
        resolve(err(Status.DatabaseError));
        return;
      }
      const rows: Row[] = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === undefined) {
          resolve(err(Status.DatabaseError));
          return;
        }
        rows.push({ key, value: vals[i] });
      }
      resolve(ok(rows));
    };
    const keysReq = store.getAllKeys(query, PAGE);
    const valsReq = store.getAll(query, PAGE);
    keysReq.onsuccess = () => {
      keys = keysReq.result;
      finish();
    };
    valsReq.onsuccess = () => {
      vals = valsReq.result;
      finish();
    };
    keysReq.onerror = () => fail();
    valsReq.onerror = () => fail();
  });
}

function putRows(
  db: IDBDatabase,
  table: string,
  rows: Row[],
  inline: boolean,
): Promise<Status> {
  if (rows.length === 0) return Promise.resolve(Status.Success);
  const tx = db.transaction(table, "readwrite");
  const store = tx.objectStore(table);
  return new Promise((resolve) => {
    let done = false;
    const finish = (st: Status) => {
      if (done) return;
      done = true;
      resolve(st);
    };
    tx.oncomplete = () => finish(Status.Success);
    tx.onerror = () => finish(Status.DatabaseError);
    tx.onabort = () => finish(Status.DatabaseError);
    for (const row of rows) {
      if (inline) store.put(row.value);
      else store.put(row.value, row.key);
    }
  });
}

function readHosts(db: IDBDatabase): Promise<ValStat<OldHost[]>> {
  const tx = db.transaction(HOSTS_TABLE, "readonly");
  const store = tx.objectStore(HOSTS_TABLE);
  return new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const raw = req.result;
      if (!Array.isArray(raw)) {
        resolve(err(Status.DatabaseError));
        return;
      }
      const hosts: OldHost[] = [];
      for (const row of raw) {
        const host = parseHost(row);
        if (host === undefined) {
          resolve(err(Status.InvalidParam));
          return;
        }
        hosts.push(host);
      }
      resolve(ok(hosts));
    };
    req.onerror = () => resolve(err(Status.DatabaseError));
  });
}

function parseHost(row: unknown): OldHost | undefined {
  if (!isRec(row)) return undefined;
  if (typeof row.label !== "string" || row.label === "") return undefined;
  if (typeof row.handle !== "string") return undefined;
  let handle: URL;
  try {
    handle = new URL(row.handle);
  } catch {
    return undefined;
  }
  const info: IHostConnectionInfo<URL> = { label: row.label, handle };
  if (row.idx !== undefined) {
    if (
      typeof row.idx !== "number" || !Number.isInteger(row.idx) || row.idx < 0
    ) {
      return undefined;
    }
    info.idx = row.idx;
  }
  const clock = row.clockOffset;
  const sub = row.subscription;
  const hasClock = clock !== undefined;
  const hasSub = sub !== undefined;
  if (!hasClock && !hasSub) return { info };
  if (typeof clock !== "number" || !Number.isFinite(clock)) return undefined;
  const subscription = parseSub(sub);
  if (subscription === undefined) return undefined;
  return { info, meta: { clockOffset: clock, subscription } };
}

function parseSub(v: unknown): ISubscriptionMetadata | undefined {
  if (!isRec(v)) return undefined;
  const term = v.term;
  const elapsed = v.elapsed;
  if (typeof term !== "number" || !Number.isFinite(term)) return undefined;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed)) {
    return undefined;
  }
  const stat = parseQuota(v.stat);
  const dyn = parseQuota(v.dyn);
  if (stat === undefined || dyn === undefined) return undefined;
  return { term, elapsed, stat, dyn };
}

function parseQuota(v: unknown): IUsageQuota | undefined {
  if (!isRec(v) || typeof v.quota !== "number" || !Number.isFinite(v.quota)) {
    return undefined;
  }
  if (v.usage === undefined) return { quota: v.quota };
  if (typeof v.usage !== "number" || !Number.isFinite(v.usage)) {
    return undefined;
  }
  return { quota: v.quota, usage: v.usage };
}

async function writeHosts(db: IDBDatabase, hosts: OldHost[]): Promise<Status> {
  const store = new IDBHostStore(db);
  for (const host of hosts) {
    await store.add(host.info);
    if (host.meta === undefined) continue;
    const st = await store.set(host.info.label, host.meta);
    if (st !== Status.Success) return st;
  }
  return Status.Success;
}

async function msgHash(db: IDBDatabase, crypto: ICrypto): Promise<Hash> {
  const keys = await new IDBMessageStore(db, crypto).listKeys();
  return checksumSet(keys, crypto);
}
