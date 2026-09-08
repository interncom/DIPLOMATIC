// Public Enclave methods must be non-writable / non-configurable after load.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";

const SKIP = new Set(["constructor", "prototype", "length", "name"]);

// Own function keys on a constructor or prototype (not private slots).
function fnKeys(obj: object): string[] {
  return Object.getOwnPropertyNames(obj).filter((k) => {
    if (SKIP.has(k)) return false;
    const d = Object.getOwnPropertyDescriptor(obj, k);
    return typeof d?.value === "function";
  });
}

function assertLocked(obj: object, key: string, where: string) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  assertEquals(d?.writable, false, `${where}.${key} writable`);
  assertEquals(d?.configurable, false, `${where}.${key} configurable`);
}

Deno.test("Enclave static methods are locked", () => {
  const keys = fnKeys(Enclave);
  assert(keys.length > 0, "expected static methods");
  for (const k of keys) assertLocked(Enclave, k, "Enclave");
});

Deno.test("Enclave instance methods are locked", () => {
  const keys = fnKeys(Enclave.prototype);
  assert(keys.length > 0, "expected instance methods");
  for (const k of keys) assertLocked(Enclave.prototype, k, "Enclave.prototype");
});

Deno.test("pairRequest instance methods are locked", async () => {
  const [req, st] = await Enclave.pairRequest();
  assertEquals(st, Status.Success);
  assert(req !== undefined);
  const proto = Object.getPrototypeOf(req);
  const keys = fnKeys(proto);
  assert(keys.length > 0, "expected instance methods");
  for (const k of keys) assertLocked(proto, k, "pairRequest");
});
