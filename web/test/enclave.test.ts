// Iron Law: imported functions must not receive the seed (or a copy).
// File-local / #private calls are invisible. ESM named imports are only
// intercepted if the spy is installed via vi.mock (hoisted).

import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesEqual } from "../src/shared/binary";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { asMasterSeed } from "../src/shared/seed";
import * as largeBlob from "../src/shared/webauthn/largeBlob";

const { trace, wrapFns } = vi.hoisted(() => {
  const trace: { seed: Uint8Array | undefined; hits: string[] } = {
    seed: undefined,
    hits: [],
  };

  function valHasSeed(
    v: unknown,
    seed: Uint8Array,
    seen: WeakSet<object>,
  ): boolean {
    if (v instanceof Uint8Array) return bytesEqual(v, seed);
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

function seedOf(fill: number) {
  const [seed, st] = asMasterSeed(new Uint8Array(32).fill(fill));
  if (st !== Status.Success || seed === undefined) {
    throw new Error(`seed ${st}`);
  }
  return seed;
}

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(seedOf(fill));
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
    const e = enclaveOf(3);
    trace.seed = seedOf(3);
    vi.spyOn(largeBlob, "largeBlobWrite").mockResolvedValue(Status.Success);

    const [id, st] = await e.persistToLargeBlob([], {
      credId: new Uint8Array(16).fill(7),
    });
    expect(st).toBe(Status.Success);
    expect(id).toBeDefined();
    expect(trace.hits).toEqual([]);
  });
});
