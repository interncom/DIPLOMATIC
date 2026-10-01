import { afterEach, describe, expect, test, vi } from "vitest";
import crypto from "../src/crypto";
import { btob64url, btoh } from "../src/shared/binary";
import { hashBytes, Status } from "../src/shared/consts";
import { asChildKey, Purpose } from "../src/shared/crypto/derivation";
import { Enclave, MUSEC_MIN_LEN } from "../src/shared/crypto/enclave";
import { asSealedMasterKey, SEALED_MASTER_KEY_LEN } from "../src/shared/seed";
import { DEFAULT_PRF_SALT } from "../src/shared/webauthn/prf";
import type { Keyring } from "../src/passkey/prf-store";
import {
  accountFromSeedMeta,
  decodeAccount,
  IDBAccountStore,
} from "../src/stores/idb/account";
import { MemoryAccountStore } from "../src/stores/memory/account";

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(new Uint8Array(32).fill(fill));
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclaveOf ${st}`);
  }
  return e;
}

function rowLabel(val: unknown): string | undefined {
  if (val === null || typeof val !== "object" || !("label" in val)) {
    return undefined;
  }
  return typeof val.label === "string" ? val.label : undefined;
}

/** Minimal IDB: getAll/put/delete/clear, ops applied before oncomplete. */
function fakeSeedDb(rows: Map<string, unknown>): IDBDatabase {
  return {
    transaction() {
      let pending = 0;
      const ops: Array<() => void> = [];
      const tx = {
        error: null as DOMException | null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore() {
          return {
            get(key: IDBValidKey) {
              pending++;
              const req: IDBRequest = {
                result: undefined,
                error: null,
                onsuccess: null,
                onerror: null,
              } as IDBRequest;
              queueMicrotask(() => {
                req.result = typeof key === "string"
                  ? rows.get(key)
                  : undefined;
                req.onsuccess?.call(req, new Event("success"));
                pending--;
                flush();
              });
              return req;
            },
            getAll() {
              pending++;
              const req: IDBRequest = {
                result: undefined,
                error: null,
                onsuccess: null,
                onerror: null,
              } as IDBRequest;
              queueMicrotask(() => {
                req.result = [...rows.values()];
                req.onsuccess?.call(req, new Event("success"));
                pending--;
                flush();
              });
              return req;
            },
            put(val: unknown) {
              ops.push(() => {
                const label = rowLabel(val);
                if (label !== undefined) rows.set(label, val);
              });
              return { onerror: null };
            },
            delete(key: IDBValidKey) {
              ops.push(() => {
                if (typeof key === "string") rows.delete(key);
              });
              return { onerror: null };
            },
            clear() {
              ops.push(() => rows.clear());
            },
          };
        },
      };
      const flush = () => {
        if (pending > 0) return;
        for (const op of ops) op();
        ops.length = 0;
        tx.oncomplete?.();
      };
      queueMicrotask(flush);
      return tx;
    },
  } as unknown as IDBDatabase;
}

function mustRing(): Keyring {
  const [sealed, sst] = asSealedMasterKey(
    new Uint8Array(SEALED_MASTER_KEY_LEN).fill(1),
  );
  const [tag, tst] = asChildKey(
    new Uint8Array(hashBytes).fill(2),
    Purpose.BindTag,
  );
  if (sst !== Status.Success || tst !== Status.Success) {
    throw new Error("mustRing");
  }
  return {
    salt: new Uint8Array(hashBytes).fill(3),
    entries: [{
      type: "prf",
      sealedMaster: sealed,
      credId: new Uint8Array([4]),
      tag,
      enrolledAt: 1,
    }],
  };
}

function fields(
  raw: unknown,
): { label: string; keyTag: unknown; idPin: unknown; keyring: unknown } {
  if (raw === null || typeof raw !== "object") throw new Error("row");
  if (!("label" in raw) || typeof raw.label !== "string") {
    throw new Error("label");
  }
  return {
    label: raw.label,
    keyTag: "keyTag" in raw ? raw.keyTag : undefined,
    idPin: "idPin" in raw ? raw.idPin : undefined,
    keyring: "keyring" in raw ? raw.keyring : undefined,
  };
}

describe("seed store enclave is private", () => {
  test("MemoryAccountStore does not expose enclave", async () => {
    const store = new MemoryAccountStore(crypto);
    const [enc, st] = await store.save(enclaveOf(1));
    expect(st).toBe(Status.Success);
    expect(enc).toBeDefined();
    expect("enclave" in store).toBe(false);
  });

  test("IDBAccountStore does not expose enclave", async () => {
    const store = new IDBAccountStore(fakeSeedDb(new Map()), crypto);
    const [enc, st] = await store.save(enclaveOf(1));
    expect(st).toBe(Status.Success);
    expect(enc).toBeDefined();
    expect("enclave" in store).toBe(false);
  });
});

describe("accounts row", () => {
  // TODO(accounts-sunset): seedMeta copy and the v4 generated-id key.
  test("accountFromSeedMeta keeps key tag and keyring, drops empty legacy", () => {
    const ring = mustRing();
    const tag = {
      n: new Uint8Array(32).fill(1),
      h: new Uint8Array(32).fill(2),
    };
    const row = accountFromSeedMeta("a", tag, ring);
    expect(row?.label).toBe("a");
    expect(row?.keyTag?.n).toEqual(tag.n);
    expect(row?.keyring?.entries.length).toBe(1);
    expect(accountFromSeedMeta("a", undefined, undefined)).toBeUndefined();
    expect(accountFromSeedMeta("a", { n: "nope" }, undefined)).toBeUndefined();
    // TODO(accounts-sunset): rows stored the field as idPin.
    const adopted = decodeAccount({ id: "old-uuid", idPin: tag });
    expect(adopted?.label).toBe("old-uuid");
    expect(adopted?.keyTag?.n).toEqual(tag.n);
    expect(decodeAccount({ label: "home", id: "old-uuid" })?.label).toBe(
      "home",
    );
    expect(decodeAccount({ label: "" })?.label).toBe("");
    expect(accountFromSeedMeta("", tag, undefined)?.keyTag?.n).toEqual(tag.n);
  });

  test("missing label is the default account and a new label is its own row", async () => {
    const rows = new Map<string, unknown>();
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    expect((await store.save(enclaveOf(1)))[1]).toBe(Status.Success);
    expect(fields(rows.get("")).label).toBe("");
    expect(fields(rows.get("")).keyTag).toBeDefined();
    expect((await store.save(enclaveOf(1), { label: "  " }))[1]).toBe(
      Status.Success,
    );
    expect(rows.size).toBe(1);
    expect((await store.save(enclaveOf(2)))[1]).toBe(Status.HashMismatch);
    expect(fields(rows.get("")).keyTag).toBeDefined();

    const ring = mustRing();
    rows.set("home", { label: "home", keyring: ring });
    expect((await store.save(enclaveOf(3), { label: "home" }))[1]).toBe(
      Status.Success,
    );
    const home = fields(rows.get("home"));
    expect(home.keyTag).toBeDefined();
    expect(home.idPin).toBeUndefined();
    expect(home.keyring).toBeDefined();
    expect(fields(rows.get("")).keyTag).not.toEqual(home.keyTag);

    expect((await store.save(enclaveOf(1), { label: "home" }))[1]).toBe(
      Status.HashMismatch,
    );
    expect(fields(rows.get("home")).keyring).toBeDefined();

    expect((await store.save(enclaveOf(4), { label: "work" }))[1]).toBe(
      Status.Success,
    );
    expect(rows.size).toBe(3);
    expect(fields(rows.get("home")).keyTag).not.toEqual(
      fields(rows.get("work")).keyTag,
    );
    expect(await store.persistKeyring(undefined, "work")).toBe(Status.Success);
    const work = fields(rows.get("work"));
    expect(work.keyTag).toBeDefined();
    expect(work.keyring).toBeUndefined();
    expect(fields(rows.get("home")).keyring).toBeDefined();

    await store.wipe();
    expect(rows.size).toBe(0);
    expect((await store.save(enclaveOf(9), { label: "work" }))[1]).toBe(
      Status.Success,
    );
    expect(rows.has("work")).toBe(true);
  });

  // TODO(accounts-sunset): a pubkey-hash row stored as idPin is rewritten
  // onto keyTag on the next save.
  test("legacy key tag rewrites in the account row", async () => {
    const enc = enclaveOf(4);
    const n = new Uint8Array(32).fill(9);
    const [idnt, ist] = await enc.deriveIdentity({
      label: "diplomatic.pin/" + btoh(n),
      index: 0,
    });
    expect(ist).toBe(Status.Success);
    if (idnt === undefined) return;
    const old = await crypto.blake3(idnt.publicKey);
    const rows = new Map<string, unknown>();
    rows.set("home", { label: "home", idPin: { n, h: old } });
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    expect((await store.save(enclaveOf(1), { label: "home" }))[1]).toBe(
      Status.HashMismatch,
    );
    expect(fields(rows.get("home")).idPin).toEqual({ n, h: old });
    expect(fields(rows.get("home")).keyTag).toBeUndefined();
    expect((await store.save(enc, { label: "home" }))[1]).toBe(Status.Success);
    const [child, cst] = await enc.fingerprint(n);
    expect(cst).toBe(Status.Success);
    const keptRow = fields(rows.get("home"));
    expect(keptRow.idPin).toBeUndefined();
    const kept = keptRow.keyTag;
    expect(kept).toMatchObject({ n });
    if (kept === null || typeof kept !== "object" || !("h" in kept)) return;
    expect(kept.h).toEqual(child);
    expect(kept.h).not.toEqual(old);
  });

  // TODO(accounts-sunset): a current key tag stored as idPin is renamed.
  test("idPin field moves onto keyTag", async () => {
    const enc = enclaveOf(4);
    const n = new Uint8Array(32).fill(8);
    const [h, st] = await enc.fingerprint(n);
    expect(st).toBe(Status.Success);
    const rows = new Map<string, unknown>();
    rows.set("home", { label: "home", idPin: { n, h } });
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    expect((await store.save(enc, { label: "home" }))[1]).toBe(Status.Success);
    const row = fields(rows.get("home"));
    expect(row.idPin).toBeUndefined();
    expect(row.keyTag).toEqual({ n, h });
  });
});

function mockCred(
  rawId: ArrayBuffer,
  prf: Uint8Array,
): PublicKeyCredential {
  return {
    type: "public-key",
    id: "x",
    rawId,
    response: {} as AuthenticatorAssertionResponse,
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({
      prf: {
        results: {
          first: prf.buffer.slice(
            prf.byteOffset,
            prf.byteOffset + prf.byteLength,
          ),
        },
      },
    }),
  } as PublicKeyCredential;
}

function stubGet(credId: Uint8Array, prf: Uint8Array) {
  const rawId = credId.buffer.slice(
    credId.byteOffset,
    credId.byteOffset + credId.byteLength,
  );
  const get = vi.fn().mockResolvedValue(mockCred(rawId, prf));
  const g = globalThis as {
    navigator?: { credentials?: unknown };
    PublicKeyCredential?: unknown;
    location?: { hostname: string };
  };
  if (g.navigator !== undefined) {
    Object.defineProperty(g.navigator, "credentials", {
      configurable: true,
      value: { get },
    });
  } else {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { credentials: { get }, userAgent: "Macintosh" },
    });
  }
  g.PublicKeyCredential = class {};
  if (g.location === undefined) {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { hostname: "localhost" },
    });
  }
  return get;
}

async function sealedRing(
  enc: Enclave,
  prf: Uint8Array,
  credId: Uint8Array,
  salt: Uint8Array,
): Promise<Keyring> {
  const [sealed, sst] = await enc.sealWithIkm(prf.slice());
  if (sst !== Status.Success || sealed === undefined) {
    throw new Error("seal");
  }
  const [tag, tst] = asChildKey(
    new Uint8Array(hashBytes).fill(2),
    Purpose.BindTag,
  );
  if (tst !== Status.Success) throw new Error("tag");
  return {
    salt,
    entries: [{
      type: "prf",
      sealedMaster: sealed,
      credId,
      tag,
      enrolledAt: 1,
    }],
  };
}

async function paper(enc: Enclave): Promise<Uint8Array> {
  const [fp, st] = await enc.fingerprint();
  if (st !== Status.Success || fp === undefined) throw new Error("fp");
  return fp;
}

function entryUsedAt(raw: unknown): number | undefined {
  if (raw === null || typeof raw !== "object" || !("keyring" in raw)) {
    return undefined;
  }
  const ring = raw.keyring;
  if (ring === null || typeof ring !== "object" || !("entries" in ring)) {
    return undefined;
  }
  const entries = ring.entries;
  if (!Array.isArray(entries)) return undefined;
  const e = entries[0];
  if (e === null || typeof e !== "object" || !("lastUsedAt" in e)) {
    return undefined;
  }
  return typeof e.lastUsedAt === "number" ? e.lastUsedAt : undefined;
}

describe("unlock selects the account by credId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("the asserted passkey opens that account", async () => {
    const home = enclaveOf(1);
    const work = enclaveOf(2);
    const homePrf = new Uint8Array(32).fill(3);
    const workPrf = new Uint8Array(32).fill(4);
    const homeCred = new Uint8Array([1, 2, 3]);
    const workCred = new Uint8Array([4, 5, 6]);
    const homeRing = await sealedRing(
      home,
      homePrf,
      homeCred,
      DEFAULT_PRF_SALT,
    );
    const workRing = await sealedRing(
      work,
      workPrf,
      workCred,
      DEFAULT_PRF_SALT,
    );
    const rows = new Map<string, unknown>();
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    expect((await store.save(home, { label: "home" }))[1]).toBe(Status.Success);
    expect(await store.persistKeyring(homeRing)).toBe(Status.Success);
    expect((await store.save(work, { label: "work" }))[1]).toBe(Status.Success);
    expect(await store.persistKeyring(workRing, "work")).toBe(Status.Success);

    const get = stubGet(homeCred, homePrf);
    const [opened, st] = await store.unlock({ rpId: "localhost" });
    expect(st).toBe(Status.Success);
    if (opened === undefined) return;
    expect(opened.label).toBe("home");
    expect(await paper(opened.enclave)).toEqual(await paper(home));
    const ring = await store.loadKeyring(opened.label);
    expect(ring?.entries[0]?.credId).toEqual(homeCred);
    expect(ring?.entries[0]?.lastUsedAt).toBeTypeOf("number");
    expect(entryUsedAt(rows.get("work"))).toBeUndefined();
    const allow = get.mock.calls[0][0].publicKey.allowCredentials;
    expect(allow).toHaveLength(2);
    expect(get.mock.calls[0][0].publicKey.extensions.prf.evalByCredential)
      .toBeUndefined();

    const [prf, ost] = await store.openPrfStore({ rpId: "localhost" });
    expect(ost).toBe(Status.Success);
    if (prf === undefined) return;
    stubGet(workCred, workPrf);
    const [again, ast] = await prf.unlock();
    expect(ast).toBe(Status.Success);
    if (again === undefined) return;
    expect(await paper(again)).toEqual(await paper(work));
    expect(prf.list()[0]?.credId).toEqual(workCred);
    expect(prf.list()[0]?.lastUsedAt).toBeTypeOf("number");
    expect(entryUsedAt(rows.get("home"))).toBeTypeOf("number");
  });

  test("distinct salts are sent per cred", async () => {
    const home = enclaveOf(1);
    const work = enclaveOf(2);
    const homePrf = new Uint8Array(32).fill(5);
    const workPrf = new Uint8Array(32).fill(6);
    const homeCred = new Uint8Array([7]);
    const workCred = new Uint8Array([8]);
    const homeSalt = new Uint8Array([9, 9]);
    const workSalt = new Uint8Array([8, 8]);
    const rows = new Map<string, unknown>();
    rows.set("home", {
      label: "home",
      keyring: await sealedRing(home, homePrf, homeCred, homeSalt),
    });
    rows.set("work", {
      label: "work",
      keyring: await sealedRing(work, workPrf, workCred, workSalt),
    });
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    const get = stubGet(workCred, workPrf);
    const [opened, st] = await store.unlock({ rpId: "localhost" });
    expect(st).toBe(Status.Success);
    if (opened === undefined) return;
    expect(await paper(opened.enclave)).toEqual(await paper(work));
    const byCred =
      get.mock.calls[0][0].publicKey.extensions.prf.evalByCredential;
    expect(new Uint8Array(byCred[btob64url(homeCred)].first)).toEqual(homeSalt);
    expect(new Uint8Array(byCred[btob64url(workCred)].first)).toEqual(workSalt);
  });

  test("a key tag that does not match does not switch accounts", async () => {
    const home = enclaveOf(1);
    const other = enclaveOf(2);
    const prf = new Uint8Array(32).fill(7);
    const cred = new Uint8Array([9]);
    const rows = new Map<string, unknown>();
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    expect((await store.save(home, { label: "home" }))[1]).toBe(Status.Success);
    expect(
      await store.persistKeyring(
        await sealedRing(other, prf, cred, DEFAULT_PRF_SALT),
      ),
    ).toBe(Status.Success);
    stubGet(cred, prf);
    const [opened, st] = await store.unlock({ rpId: "localhost" });
    expect(st).toBe(Status.HashMismatch);
    expect(opened).toBeUndefined();
    expect(entryUsedAt(rows.get("home"))).toBeUndefined();
  });

  test("the same credId on two accounts is refused before a prompt", async () => {
    const id = new Uint8Array([1, 2, 3]);
    const home = mustRing();
    const work = mustRing();
    const homeEntry = home.entries[0];
    const workEntry = work.entries[0];
    if (homeEntry === undefined || workEntry === undefined) return;
    homeEntry.credId = id;
    workEntry.credId = id.slice();
    const rows = new Map<string, unknown>();
    rows.set("home", { label: "home", keyring: home });
    rows.set("work", { label: "work", keyring: work });
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    const get = stubGet(id, new Uint8Array(32).fill(1));
    const [, st] = await store.unlock({ rpId: "localhost" });
    expect(st).toBe(Status.InvalidParam);
    expect(get).not.toHaveBeenCalled();
  });

  test("no passkey is MissingSeed", async () => {
    const store = new IDBAccountStore(fakeSeedDb(new Map()), crypto);
    const [, st] = await store.unlock({ rpId: "localhost" });
    expect(st).toBe(Status.MissingSeed);
  });
});

function rowKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object") return [];
  return Object.keys(raw).sort();
}

describe("create mints an account key", () => {
  test("fromRandom mixes musec and a second create does not replace the key", async () => {
    const rows = new Map<string, unknown>();
    const store = new IDBAccountStore(fakeSeedDb(rows), crypto);
    const musec = new Uint8Array(MUSEC_MIN_LEN).fill(7);
    const [enc, st] = await store.create(" home ", musec);
    expect(st).toBe(Status.Success);
    if (enc === undefined) return;
    expect(musec.every((b) => b === 0)).toBe(true);
    expect("enclave" in store).toBe(false);
    expect(rowKeys(rows.get("home"))).toEqual(["keyTag", "label"]);
    const tag = fields(rows.get("home")).keyTag;
    expect(tag).toBeDefined();
    expect((await store.save(enc, { label: "home" }))[1]).toBe(Status.Success);
    expect((await store.save(enclaveOf(1), { label: "home" }))[1]).toBe(
      Status.HashMismatch,
    );

    const ring = mustRing();
    expect(await store.persistKeyring(ring)).toBe(Status.Success);
    const again = new Uint8Array(MUSEC_MIN_LEN).fill(8);
    const [second, sst] = await store.create("home", again);
    expect(sst).toBe(Status.HashMismatch);
    expect(second).toBeUndefined();
    expect(again.every((b) => b === 0)).toBe(true);
    expect(fields(rows.get("home")).keyTag).toEqual(tag);
    expect(fields(rows.get("home")).keyring).toBeDefined();

    const short = new Uint8Array(MUSEC_MIN_LEN - 1).fill(9);
    const [miss, qst] = await store.create("other", short);
    expect(qst).toBe(Status.InvalidParam);
    expect(miss).toBeUndefined();
    expect(short.every((b) => b === 0)).toBe(true);
    expect(rows.has("other")).toBe(false);

    rows.set("spare", { label: "spare", keyring: mustRing() });
    const spareMusec = new Uint8Array(MUSEC_MIN_LEN).fill(4);
    const [spare, pst] = await store.create("spare", spareMusec);
    expect(pst).toBe(Status.Success);
    if (spare === undefined) return;
    expect(spareMusec.every((b) => b === 0)).toBe(true);
    expect(rowKeys(rows.get("spare"))).toEqual(["keyTag", "keyring", "label"]);
    expect(fields(rows.get("spare")).keyring).toBeDefined();
    expect(await paper(spare)).not.toEqual(await paper(enc));

    const blankRows = new Map<string, unknown>();
    const blank = new IDBAccountStore(fakeSeedDb(blankRows), crypto);
    const blankMusec = new Uint8Array(MUSEC_MIN_LEN).fill(2);
    const same = blankMusec.slice();
    const [a, ast] = await blank.create("   ", blankMusec);
    const [b, bst] = await blank.create("other", same);
    expect(ast).toBe(Status.Success);
    expect(bst).toBe(Status.Success);
    if (a === undefined || b === undefined) return;
    expect(blankRows.has("")).toBe(true);
    expect(blankRows.has("   ")).toBe(false);
    expect(await paper(a)).not.toEqual(await paper(b));
  });
});
