// Iron Law: imported functions must not receive the seed, a copy, or
// framed plaintext (seed bytes embedded in a larger buffer).
// File-local / #private calls are invisible. ESM named imports are only
// intercepted if the spy is installed via vi.mock (hoisted).

import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesEqual } from "../src/shared/binary";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { asMasterSeed, type MasterSeed } from "../src/shared/seed";

const { trace, wrapFns } = vi.hoisted(() => {
  const trace: { seed: Uint8Array | undefined; hits: string[] } = {
    seed: undefined,
    hits: [],
  };

  function bufHasSeed(buf: Uint8Array, seed: Uint8Array): boolean {
    if (buf.byteLength < seed.byteLength) return false;
    if (buf.byteLength === seed.byteLength) return bytesEqual(buf, seed);
    const last = buf.byteLength - seed.byteLength;
    for (let i = 0; i <= last; i++) {
      if (bytesEqual(buf.subarray(i, i + seed.byteLength), seed)) return true;
    }
    return false;
  }

  function valHasSeed(
    v: unknown,
    seed: Uint8Array,
    seen: WeakSet<object>,
  ): boolean {
    if (v instanceof Uint8Array) return bufHasSeed(v, seed);
    if (v instanceof ArrayBuffer) return bufHasSeed(new Uint8Array(v), seed);
    if (v === null || typeof v !== "object") return false;
    if (seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v)) {
      return v.some((x) => valHasSeed(x, seed, seen));
    }
    return Object.values(v).some((x) => valHasSeed(x, seed, seen));
  }

  function isCtor(v: unknown): boolean {
    if (typeof v !== "function") return false;
    const proto = v.prototype;
    if (proto === undefined) return false;
    return Object.getOwnPropertyNames(proto).some((n) => n !== "constructor");
  }

  // Wrap non-class function exports; record hits at call time (args may be
  // fill(0)'d after return).
  function wrapFns(
    prefix: string,
    orig: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...orig };
    for (const key of Object.keys(orig)) {
      const v = orig[key];
      if (typeof v !== "function" || isCtor(v)) continue;
      out[key] = (...args: unknown[]) => {
        const seed = trace.seed;
        if (seed !== undefined && valHasSeed(args, seed, new WeakSet())) {
          trace.hits.push(`${prefix}.${key}`);
        }
        return v(...args);
      };
    }
    return out;
  }

  return { trace, wrapFns };
});

vi.mock("../src/shared/codecs/identityBundle", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/codecs/identityBundle")
  >();
  return wrapFns("identityBundle", orig);
});

vi.mock("../src/shared/webauthn/largeBlob", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/webauthn/largeBlob")
  >();
  return wrapFns("largeBlob", {
    ...orig,
    largeBlobWrite: async () => Status.Success,
  });
});

function randomSeed(): MasterSeed {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const [seed, st] = asMasterSeed(bytes);
  if (st !== Status.Success || seed === undefined) {
    throw new Error(`seed ${st}`);
  }
  return seed;
}

function enclaveOf(seed: MasterSeed): Enclave {
  const [e, st] = Enclave.fromBytes(seed);
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclave ${st}`);
  }
  return e;
}

describe("Enclave imported-callee seed trace", () => {
  afterEach(() => {
    trace.seed = undefined;
    trace.hits = [];
    vi.restoreAllMocks();
  });

  it("imported functions must not receive the seed", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;

    const [id, st] = await e.persistToLargeBlob([], {
      credId: new Uint8Array(16).fill(7),
    });
    expect(st).toBe(Status.Success);
    expect(id).toBeDefined();
    expect(trace.hits).toEqual([]);
  });
});
