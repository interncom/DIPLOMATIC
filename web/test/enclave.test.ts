// Iron Law: imported functions must not receive the seed, a copy, or
// framed plaintext (seed bytes embedded in a larger buffer).
// File-local / #private calls are invisible. ESM named imports are only
// intercepted if the spy is installed via vi.mock (hoisted).

import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesEqual } from "../src/shared/binary";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { asMasterSeed, type MasterSeed } from "../src/shared/seed";

type Hit = { fn: string; how: "exact" | "embedded" };

const { trace, wrapFns } = vi.hoisted(() => {
  const trace: { seed: Uint8Array | undefined; hits: Hit[] } = {
    seed: undefined,
    hits: [],
  };

  // Exact 32-byte match vs seed bytes inside a larger buffer.
  function bufHow(
    buf: Uint8Array,
    seed: Uint8Array,
  ): Hit["how"] | undefined {
    if (buf.byteLength < seed.byteLength) return undefined;
    if (buf.byteLength === seed.byteLength) {
      return bytesEqual(buf, seed) ? "exact" : undefined;
    }
    const last = buf.byteLength - seed.byteLength;
    for (let i = 0; i <= last; i++) {
      if (bytesEqual(buf.subarray(i, i + seed.byteLength), seed)) {
        return "embedded";
      }
    }
    return undefined;
  }

  function valHow(
    v: unknown,
    seed: Uint8Array,
    seen: WeakSet<object>,
  ): Hit["how"] | undefined {
    if (v instanceof Uint8Array) return bufHow(v, seed);
    if (v instanceof ArrayBuffer) return bufHow(new Uint8Array(v), seed);
    if (v === null || typeof v !== "object") return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);
    const kids = Array.isArray(v) ? v : Object.values(v);
    let embedded = false;
    for (const x of kids) {
      const how = valHow(x, seed, seen);
      if (how === "exact") return "exact";
      if (how === "embedded") embedded = true;
    }
    return embedded ? "embedded" : undefined;
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
    impls?: Record<string, (...args: never[]) => unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...orig };
    for (const key of Object.keys(orig)) {
      const v = orig[key];
      if (typeof v !== "function" || isCtor(v)) continue;
      const impl = impls?.[key] ?? v;
      out[key] = (...args: unknown[]) => {
        const seed = trace.seed;
        if (seed !== undefined) {
          const how = valHow(args, seed, new WeakSet());
          if (how !== undefined) {
            trace.hits.push({ fn: `${prefix}.${key}`, how });
          }
        }
        return impl(...args);
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
  return wrapFns("largeBlob", orig);
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

function stubWrittenGet(credId: Uint8Array) {
  const get = vi.fn().mockResolvedValue({
    type: "public-key",
    rawId: credId,
    getClientExtensionResults: () => ({ largeBlob: { written: true } }),
  });
  const g = globalThis as {
    navigator?: { credentials?: unknown };
    PublicKeyCredential?: unknown;
    location?: { hostname: string };
  };
  if (g.navigator !== undefined) {
    Object.defineProperty(g.navigator, "credentials", {
      configurable: true,
      writable: true,
      value: { create: vi.fn(), get },
    });
  } else {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { credentials: { create: vi.fn(), get } },
    });
  }
  g.PublicKeyCredential = class {};
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { hostname: "localhost" },
  });
  return get;
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
    const credId = new Uint8Array(16).fill(7);
    stubWrittenGet(credId);

    const [id, st] = await e.persistToLargeBlob([], {
      credId,
    });
    expect(st).toBe(Status.Success);
    expect(id).toBeDefined();
    expect(trace.hits).toEqual([]);
  });
});
