import { describe, expect, test } from "vitest";
import crypto from "../src/crypto";
import { Enclave } from "../src/shared/crypto/enclave";
import { Status } from "../src/shared/consts";
import { IDBSeedStore } from "../src/stores/idb/seed";
import { MemorySeedStore } from "../src/stores/memory/seed";

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(crypto, new Uint8Array(32).fill(fill));
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclaveOf ${st}`);
  }
  return e;
}

/** Minimal IDB that runs get/put/delete then oncomplete (microtask-ordered). */
function fakeSeedDb(rows: Map<IDBValidKey, unknown>): IDBDatabase {
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
                req.result = rows.get(key);
                req.onsuccess?.call(req, new Event("success"));
                pending--;
                flush();
              });
              return req;
            },
            put(val: unknown, key: IDBValidKey) {
              ops.push(() => {
                rows.set(key, val);
              });
              return { onerror: null };
            },
            delete(key: IDBValidKey) {
              ops.push(() => {
                rows.delete(key);
              });
              return { onerror: null };
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

describe("seed store enclave is private", () => {
  test("MemorySeedStore does not expose enclave", async () => {
    const store = new MemorySeedStore(crypto);
    await store.save(enclaveOf(1));
    expect("enclave" in store).toBe(false);
    expect(await store.load()).toBeDefined();
  });

  test("IDBSeedStore does not expose enclave", async () => {
    const store = new IDBSeedStore(fakeSeedDb(new Map()), crypto);
    await store.save(enclaveOf(1));
    expect("enclave" in store).toBe(false);
    expect(await store.load()).toBeDefined();
  });
});
