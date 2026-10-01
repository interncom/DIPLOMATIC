// Accounts table: one row per account, keyed by label. The default is "".
// The account key is the master seed for that label. Several can live in one app.
// The row stores a binding (the PRF keyring: seals of that key), not the key.
// The session enclave holds the plaintext. A passphrase seal would be another field.
//
// keyTag names the key, so setSeed / largeBlob restore cannot switch keys
// under that account. unlock() returns the account whose passkey was asserted.
// The client holds the open account.

import { bytesEqual } from "../../shared/binary";
import { Status } from "../../shared/consts";
import { Enclave, MUSEC_MIN_LEN } from "../../shared/crypto/enclave";
import type { ICrypto } from "../../shared/types";
import { err, ok, type ValStat } from "../../shared/valstat";
import type { PrfRp } from "../../shared/webauthn/prf";
import type { IAccountStore, SetSeedOpts } from "../../types";
import {
  cloneKeyring,
  decodeKeyring,
  type Keyring,
  type KeyringEntry,
  PrfSeedStore,
  type PrfSeedStoreOpts,
  touchKeyring,
} from "../../passkey/prf-store";
import {
  cloneKeyTag,
  decodeKeyTag,
  type KeyTag,
  keyTagMatches,
  makeKeyTag,
} from "../keyTag";
import { accountLabel } from "../label";
import { ACCOUNTS_TABLE } from "./store";

/** One account: its label, a key tag, and the binding that unseals its key. */
export type Account = {
  label: string;
  keyTag?: KeyTag;
  keyring?: Keyring;
};

// TODO(accounts-sunset): builds a row from seedMeta. Delete with adoptSeedMeta.
export function accountFromSeedMeta(
  label: string,
  tagRaw: unknown,
  ringRaw: unknown,
): Account | undefined {
  const keyTag = decodeKeyTag(tagRaw);
  const keyring = decodeKeyring(ringRaw);
  if (keyTag === undefined && keyring === undefined) return undefined;
  const row: Account = { label };
  if (keyTag !== undefined) row.keyTag = keyTag;
  if (keyring !== undefined) row.keyring = keyring;
  return row;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

// Reads an account row.
export function decodeAccount(raw: unknown): Account | undefined {
  if (!isRec(raw)) return undefined;
  let label: string | undefined;
  if (typeof raw.label === "string") label = raw.label;
  // TODO(accounts-sunset): v4 key was a generated id.
  // Drop once those DBs have opened v5.
  else if (typeof raw.id === "string" && raw.id !== "") label = raw.id;
  if (label === undefined) return undefined;
  const row: Account = { label };
  // TODO(accounts-sunset): the field was idPin.
  const keyTag = decodeKeyTag(raw.keyTag ?? raw.idPin);
  const keyring = decodeKeyring(raw.keyring);
  if (keyTag !== undefined) row.keyTag = keyTag;
  if (keyring !== undefined) row.keyring = keyring;
  return row;
}

type PasskeyCred = {
  label: string;
  salt: Uint8Array;
  sealedMaster: KeyringEntry["sealedMaster"];
  credId: Uint8Array;
};

// Collects passkeys that unseal an account.
// The same credId on two labels is InvalidParam.
function passkeyCreds(accts: Account[]): ValStat<PasskeyCred[]> {
  const out: PasskeyCred[] = [];
  for (const acct of accts) {
    const ring = acct.keyring;
    if (ring === undefined) continue;
    for (const e of ring.entries) {
      if (e.credId.byteLength === 0) continue;
      let same = false;
      for (const prev of out) {
        if (!bytesEqual(prev.credId, e.credId)) continue;
        if (prev.label !== acct.label) return err(Status.InvalidParam);
        same = true;
        break;
      }
      if (same) continue;
      out.push({
        label: acct.label,
        salt: ring.salt,
        sealedMaster: e.sealedMaster,
        credId: e.credId,
      });
    }
  }
  return ok(out);
}

function accountsFrom(raw: unknown): Account[] {
  if (!Array.isArray(raw)) return [];
  const out: Account[] = [];
  for (const item of raw) {
    const row = decodeAccount(item);
    if (row !== undefined) out.push(row);
  }
  return out;
}

// Writes one account. Omits the key tag or keyring when that side is absent.
function putAccount(
  store: IDBObjectStore,
  label: string,
  keyTag: unknown,
  keyring: unknown,
): void {
  const row: { label: string; keyTag?: unknown; keyring?: unknown } = {
    label,
  };
  if (keyTag !== undefined) row.keyTag = keyTag;
  if (keyring !== undefined) row.keyring = keyring;
  store.put(row);
}

export class IDBAccountStore implements IAccountStore {
  db: IDBDatabase;
  #crypto: ICrypto;

  constructor(db: IDBDatabase, crypto: ICrypto) {
    this.db = db;
    this.#crypto = crypto;
  }

  /**
   * Mint an account key with {@link Enclave.fromRandom} and store its key tag.
   * A blank label is "". A label that already names a key is unchanged.
   * An existing keyring on that row is kept. musec is wiped.
   */
  async create(
    label: string,
    musec: Uint8Array,
  ): Promise<ValStat<Enclave>> {
    const [name, lst] = accountLabel(label);
    if (lst !== Status.Success || name === undefined) {
      musec.fill(0);
      return err(Status.InvalidParam);
    }
    const got = await this.#get(name);
    if (got.acct?.keyTag !== undefined) {
      musec.fill(0);
      return err(Status.HashMismatch);
    }
    if (musec.byteLength < MUSEC_MIN_LEN) {
      musec.fill(0);
      return err(Status.InvalidParam);
    }
    const [enclave, est] = await Enclave.fromRandom(musec);
    if (est !== Status.Success) return err(est);
    return this.save(enclave, { label: name });
  }

  /**
   * Record the key tag for `opts.label`. Does not open the account.
   * Durable identity is the account keyring
   * ({@link openPrfStore} / {@link persistKeyring}), never plain seed.
   * The row is created on the first save. A later save must match that
   * account's key tag. `opts.persist` is ignored (kept for API compatibility).
   *
   * TODO(passphrase): when PRF is missing, seal under a passphrase KDF
   * and store that ciphertext on this account row.
   */
  async save(
    enclave: Enclave,
    opts?: SetSeedOpts,
  ): Promise<ValStat<Enclave>> {
    const [label, lst] = accountLabel(opts?.label);
    if (lst !== Status.Success || label === undefined) {
      return err(Status.InvalidParam);
    }
    const st = await this.#assertKeyTag(enclave, label);
    if (st !== Status.Success) return err(st);
    return ok(enclave);
  }

  async wipe() {
    const tx = this.db.transaction(ACCOUNTS_TABLE, "readwrite");
    const store = tx.objectStore(ACCOUNTS_TABLE);
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      store.clear();
    });
  }

  async loadKeyring(label?: string): Promise<Keyring | undefined> {
    const [name, st] = await this.#boundLabel(label);
    if (st !== Status.Success || name === undefined) return undefined;
    const got = await this.#get(name);
    return got.acct?.keyring;
  }

  async persistKeyring(
    ring: Keyring | undefined,
    label?: string,
  ): Promise<Status> {
    let copy: Keyring | undefined;
    if (ring !== undefined) {
      const [cloned, st] = cloneKeyring(ring);
      if (st !== Status.Success) return st;
      copy = cloned;
    }
    const [name, lst] = await this.#boundLabel(label);
    if (lst !== Status.Success) return lst;
    if (name === undefined) return Status.NotFound;
    await this.#change(name, (cur) => {
      if (copy === undefined) {
        if (cur?.keyTag === undefined) return undefined;
        return { label: name, keyTag: cur.keyTag };
      }
      const next: Account = { label: name, keyring: copy };
      if (cur?.keyTag !== undefined) next.keyTag = cur.keyTag;
      return next;
    });
    return Status.Success;
  }

  async hasKeyring(label?: string): Promise<boolean> {
    const r = await this.loadKeyring(label);
    return r !== undefined && r.entries.length > 0;
  }

  // Passkey UV. Returns the account whose credId was asserted.
  // A key tag that does not match is HashMismatch. The account list is unchanged.
  async unlock(
    opts: PrfRp,
  ): Promise<ValStat<{ enclave: Enclave; label: string }>> {
    const [creds, cst] = passkeyCreds(await this.#list());
    if (cst !== Status.Success) return err(cst);
    if (creds === undefined || creds.length === 0) {
      return err(Status.MissingSeed);
    }
    const first = creds[0];
    if (first === undefined) return err(Status.MissingSeed);
    const [out, ust] = await Enclave.unsealWithPasskey(
      creds.map((c) => ({
        sealedMaster: c.sealedMaster,
        credId: c.credId,
        salt: c.salt,
      })),
      { rpId: opts.rpId, rpName: opts.rpName, salt: first.salt },
    );
    if (ust !== Status.Success) return err(ust);
    if (out === undefined) return err(Status.DecryptionError);
    const hit = creds.find((c) => bytesEqual(c.credId, out.credId));
    if (hit === undefined) return err(Status.NotFound);
    const got = await this.#get(hit.label);
    const tag = got.acct?.keyTag;
    if (tag !== undefined) {
      const match = await keyTagMatches(this.#crypto, out.enclave, tag);
      if (!match.ok) return err(Status.HashMismatch);
    }
    const ring = got.acct?.keyring;
    if (ring === undefined) return err(Status.NotFound);
    const [next, tst] = touchKeyring(ring, out.credId);
    if (tst !== Status.Success) return err(tst);
    if (next !== undefined) {
      await this.#change(hit.label, (cur) => {
        const row: Account = { label: hit.label, keyring: next };
        if (cur?.keyTag !== undefined) row.keyTag = cur.keyTag;
        return row;
      });
    }
    return ok({ enclave: out.enclave, label: hit.label });
  }

  // One account's keyring, for bind / rename / remove.
  // Unlock on the returned store picks the account by credId.
  async openPrfStore(
    opts: Omit<
      PrfSeedStoreOpts,
      "persistKeyring" | "keyring" | "unlockAccount"
    >,
    label?: string,
  ): Promise<ValStat<PrfSeedStore>> {
    const [name, nst] = await this.#boundLabel(label);
    const keyring = nst === Status.Success
      ? await this.loadKeyring(name)
      : undefined;
    let bound = nst === Status.Success ? name : undefined;
    return PrfSeedStore.open({
      rpId: opts.rpId,
      rpName: opts.rpName,
      userName: opts.userName,
      keyring,
      persistKeyring: (r) => this.persistKeyring(r, bound),
      unlockAccount: async () => {
        const [opened, st] = await this.unlock(opts);
        if (st !== Status.Success) return err(st);
        if (opened === undefined) return err(Status.NotFound);
        bound = opened.label;
        return ok({
          enclave: opened.enclave,
          keyring: await this.loadKeyring(opened.label),
        });
      },
    });
  }

  // Checks the key tag on `label`, or writes one and creates the row.
  async #assertKeyTag(enclave: Enclave, label: string): Promise<Status> {
    const got = await this.#get(label);
    const cur = got.acct;
    if (cur?.keyTag !== undefined) {
      const hit = await keyTagMatches(this.#crypto, enclave, cur.keyTag);
      if (!hit.ok) return Status.HashMismatch;
      // TODO(accounts-sunset): rewrite a legacy pubkey-hash tag in place.
      if (hit.next !== undefined) {
        const cloned = cloneKeyTag(hit.next);
        await this.#change(label, (row) => {
          const next: Account = { label, keyTag: cloned };
          if (row?.keyring !== undefined) next.keyring = row.keyring;
          return next;
        });
      } else if (got.legacyName) {
        // TODO(accounts-sunset): the field was idPin. Move it onto keyTag.
        await this.#change(label, (row) => {
          if (row?.keyTag === undefined) return row;
          const next: Account = { label, keyTag: row.keyTag };
          if (row.keyring !== undefined) next.keyring = row.keyring;
          return next;
        });
      }
      return Status.Success;
    }
    const [tag, tst] = await makeKeyTag(this.#crypto, enclave);
    if (tst !== Status.Success) return tst;
    const cloned = cloneKeyTag(tag);
    let raced = false;
    await this.#change(label, (row) => {
      if (row?.keyTag !== undefined) {
        raced = true;
        return row;
      }
      const next: Account = { label, keyTag: cloned };
      if (row?.keyring !== undefined) next.keyring = row.keyring;
      return next;
    });
    if (!raced) return Status.Success;
    return this.#assertKeyTag(enclave, label);
  }

  // Label for a keyring read or write. An explicit label wins.
  // TODO(accounts-sunset): callers that never name a label still hit the one
  // pre-accounts identity. Require a label once every caller names one.
  async #boundLabel(label?: string): Promise<ValStat<string>> {
    if (label !== undefined) {
      const [name, st] = accountLabel(label);
      if (st !== Status.Success || name === undefined) {
        return err(Status.InvalidParam);
      }
      return ok(name);
    }
    const all = await this.#list();
    const one = all.length === 1 ? all[0] : undefined;
    if (one !== undefined) return ok(one.label);
    if (all.length === 0) return err(Status.NotFound);
    return err(Status.InvalidParam);
  }

  // Reads one account. legacyName is set when the row still uses idPin.
  #get(label: string): Promise<{ acct?: Account; legacyName: boolean }> {
    const tx = this.db.transaction(ACCOUNTS_TABLE, "readonly");
    const store = tx.objectStore(ACCOUNTS_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.get(label);
      req.onsuccess = () => {
        const raw = req.result;
        const acct = decodeAccount(raw);
        // TODO(accounts-sunset): the field was idPin.
        const legacyName = isRec(raw) && raw.keyTag === undefined &&
          raw.idPin !== undefined;
        resolve({ acct, legacyName });
      };
      req.onerror = () => reject(req.error);
    });
  }

  #list(): Promise<Account[]> {
    const tx = this.db.transaction(ACCOUNTS_TABLE, "readonly");
    const store = tx.objectStore(ACCOUNTS_TABLE);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(accountsFrom(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  // Updates the account `label`. Creates the row when `edit` returns one.
  #change(
    label: string,
    edit: (cur: Account | undefined) => Account | undefined,
  ): Promise<void> {
    const tx = this.db.transaction(ACCOUNTS_TABLE, "readwrite");
    const store = tx.objectStore(ACCOUNTS_TABLE);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const req = store.get(label);
      req.onsuccess = () => {
        const stored = isRec(req.result) ? req.result : undefined;
        const cur = decodeAccount(req.result);
        const next = edit(cur);
        if (next === undefined) {
          if (cur !== undefined) store.delete(label);
          return;
        }
        if (next === cur) return;
        // Same object the editor was handed: keep the stored bytes.
        let keyTag: unknown = undefined;
        if (next.keyTag !== undefined) {
          // TODO(accounts-sunset): the field was idPin.
          const storedTag = stored?.keyTag ?? stored?.idPin;
          keyTag = next.keyTag === cur?.keyTag && storedTag !== undefined
            ? storedTag
            : next.keyTag;
        }
        let keyring: unknown = undefined;
        if (next.keyring !== undefined) {
          keyring =
            next.keyring === cur?.keyring && stored?.keyring !== undefined
              ? stored.keyring
              : next.keyring;
        }
        putAccount(store, label, keyTag, keyring);
      };
    });
  }
}
