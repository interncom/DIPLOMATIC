// Iron Law: imported functions must not receive the seed, a copy, or
// framed plaintext (seed bytes embedded in a larger buffer).
// File-local / #private calls are invisible. ESM named imports are only
// intercepted if the spy is installed via vi.mock (hoisted).
// Class methods (Encoder, NobleCrypto) are wrapped via prototype spies.

import { blake3 } from "@noble/hashes/blake3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { btoh, bytesEqual } from "../src/shared/binary";
import { Encoder } from "../src/shared/codec";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { NobleCrypto } from "../src/shared/crypto/noble";
import { asDHKEReq } from "../src/shared/crypto/pairing";
import {
  asMasterSeed,
  asSealedMasterKey,
  SEALED_MASTER_KEY_LEN,
  type MasterSeed,
} from "../src/shared/seed";
import { DEFAULT_PRF_SALT } from "../src/shared/webauthn/prf";

type Hit = { fn: string; how: "exact" | "embedded" };
type Pin = { fn: string; how: Hit["how"]; src: string };

// Reviewed sinks: fn + how + blake3(toString).slice(0, 16) hex.
// Empty until a failure prints a line to paste here.
const ALLOW: Pin[] = [];

const { trace, wrapFns, wrapProto, origByFn, srcHex } = vi.hoisted(() => {
  const trace: { seed: Uint8Array | undefined; hits: Hit[] } = {
    seed: undefined,
    hits: [],
  };
  const origByFn = new Map<string, (...args: never[]) => unknown>();

  function srcHex(fn: (...args: never[]) => unknown): string {
    const src = Function.prototype.toString.call(fn);
    return btoh(blake3(new TextEncoder().encode(src)).subarray(0, 16));
  }

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

  function record(fn: string, args: unknown[]) {
    const seed = trace.seed;
    if (seed === undefined) return;
    const how = valHow(args, seed, new WeakSet());
    if (how !== undefined) trace.hits.push({ fn, how });
  }

  function isCtor(v: unknown): boolean {
    if (typeof v !== "function") return false;
    const proto = v.prototype;
    if (proto === undefined) return false;
    return Object.getOwnPropertyNames(proto).some((n) => n !== "constructor");
  }

  function wrapFns(
    prefix: string,
    orig: Record<string, unknown>,
    impls?: Record<string, (...args: never[]) => unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...orig };
    for (const key of Object.keys(orig)) {
      const v = orig[key];
      if (typeof v !== "function" || isCtor(v)) continue;
      const name = `${prefix}.${key}`;
      origByFn.set(name, v);
      const impl = impls?.[key] ?? v;
      out[key] = (...args: unknown[]) => {
        record(name, args);
        return impl(...args);
      };
    }
    return out;
  }

  function wrapProto(prefix: string, proto: object) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc === undefined || typeof desc.value !== "function") continue;
      const orig = desc.value;
      const name = `${prefix}.${key}`;
      origByFn.set(name, orig);
      vi.spyOn(proto, key).mockImplementation(
        function (this: unknown, ...args: unknown[]) {
          record(name, args);
          return orig.apply(this, args);
        },
      );
    }
  }

  return { trace, wrapFns, wrapProto, origByFn, srcHex };
});

// Fails on unreviewed sinks or changed bodies; prints ALLOW lines to paste.
function assertReviewed() {
  const lines: string[] = [];
  for (const hit of trace.hits) {
    const orig = origByFn.get(hit.fn);
    const hex = orig === undefined ? undefined : srcHex(orig);
    const pin = ALLOW.find((a) => a.fn === hit.fn && a.how === hit.how);
    if (hex === undefined) {
      lines.push(
        `unreviewed ${hit.fn} (${hit.how}): no original to hash`,
      );
      continue;
    }
    const row =
      `{ fn: ${JSON.stringify(hit.fn)}, how: ${JSON.stringify(hit.how)}, ` +
      `src: ${JSON.stringify(hex)} },`;
    if (pin === undefined) {
      lines.push(
        `unreviewed ${hit.fn} (${hit.how})\n` +
          `  src: ${hex}\n` +
          `  add to ALLOW in web/test/enclave.test.ts:\n    ${row}`,
      );
    } else if (pin.src !== hex) {
      lines.push(
        `${hit.fn} (${hit.how}) source changed\n` +
          `  was: ${pin.src}\n` +
          `  now: ${hex}\n` +
          `  update ALLOW src:\n    ${row}`,
      );
    }
  }
  if (lines.length > 0) {
    throw new Error(lines.join("\n\n"));
  }
}

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
  const { ok } = await import("../src/shared/valstat");
  const credId = new Uint8Array(16).fill(7);
  const blob = new Uint8Array(32).fill(1);
  return wrapFns("largeBlob", orig, {
    largeBlobRead: async () => ok({ blob: blob.slice(), credId: credId.slice() }),
    largeBlobCreateCred: async () => ok(credId.slice()),
  });
});

vi.mock("../src/shared/webauthn/prf", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/webauthn/prf")
  >();
  const { ok } = await import("../src/shared/valstat");
  const credId = new Uint8Array(16).fill(7);
  const prf = new Uint8Array(32).fill(2);
  return wrapFns("prf", orig, {
    evalPrf: async () => ok({ prf: prf.slice(), credId: credId.slice() }),
    createPrfCred: async () =>
      ok({
        prf: prf.slice(),
        credId: credId.slice(),
        prfEnabled: true,
      }),
  });
});

vi.mock("../src/shared/worker/spawn", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/worker/spawn")
  >();
  return wrapFns("spawn", orig, {
    spawnDiplomaticSyncWorker: () => ({
      postMessage() {},
      terminate() {},
    }),
    postToDiplomaticWorker: () => {},
  });
});

vi.mock("../src/shared/webauthn/common", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/webauthn/common")
  >();
  return wrapFns("common", orig);
});

vi.mock("../src/shared/crypto/pairing", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/crypto/pairing")
  >();
  return wrapFns("pairing", orig);
});

vi.mock("../src/shared/crypto/entropy", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/crypto/entropy")
  >();
  return wrapFns("entropy", orig);
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
}

describe("Enclave imported-callee seed trace", () => {
  beforeEach(() => {
    wrapProto("Encoder", Encoder.prototype);
    wrapProto("NobleCrypto", NobleCrypto.prototype);
  });

  afterEach(() => {
    trace.seed = undefined;
    trace.hits = [];
    vi.restoreAllMocks();
  });

  it("fromBytes", () => {
    const seed = randomSeed();
    trace.seed = seed;
    const [e, st] = Enclave.fromBytes(seed);
    expect(st).toBe(Status.Success);
    expect(e).toBeDefined();
    assertReviewed();
  });

  it("fromRandom", async () => {
    const seed = randomSeed();
    trace.seed = seed;
    vi.spyOn(NobleCrypto.prototype, "gen256BitSecureRandomSeed")
      .mockResolvedValue(seed);
    const e = await Enclave.fromRandom();
    expect(e).toBeDefined();
    assertReviewed();
  });

  it("sealWithPasskey", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;
    const [out, st] = await e.sealWithPasskey({
      rpId: "localhost",
      credId: new Uint8Array(16).fill(7),
      salt: DEFAULT_PRF_SALT,
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertReviewed();
  });

  it("bind", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;
    const [out, st] = await e.bind({
      rpId: "localhost",
      credId: new Uint8Array(16).fill(7),
      salt: DEFAULT_PRF_SALT,
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertReviewed();
  });

  it("unsealWithPasskey", async () => {
    const seed = randomSeed();
    trace.seed = seed;
    const [sealed, sst] = asSealedMasterKey(
      new Uint8Array(SEALED_MASTER_KEY_LEN),
    );
    expect(sst).toBe(Status.Success);
    if (sealed === undefined) return;
    const [, st] = await Enclave.unsealWithPasskey(
      [{ sealedMaster: sealed, credId: new Uint8Array(16).fill(7) }],
      { rpId: "localhost", salt: DEFAULT_PRF_SALT },
    );
    expect(st).not.toBe(Status.Success);
    assertReviewed();
  });

  it("persistToLargeBlob", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;
    const credId = new Uint8Array(16).fill(7);
    stubWrittenGet(credId);
    const [id, st] = await e.persistToLargeBlob([], { credId });
    expect(st).toBe(Status.Success);
    expect(id).toBeDefined();
    assertReviewed();
  });

  it("fromLargeBlob", async () => {
    const seed = randomSeed();
    trace.seed = seed;
    const [out, st] = await Enclave.fromLargeBlob({
      rpId: "localhost",
      credId: new Uint8Array(16).fill(7),
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertReviewed();
  });

  it("clearLargeBlob", async () => {
    const seed = randomSeed();
    trace.seed = seed;
    const credId = new Uint8Array(16).fill(7);
    stubWrittenGet(credId);
    const st = await Enclave.clearLargeBlob(credId, { rpId: "localhost" });
    expect(st).toBe(Status.Success);
    assertReviewed();
  });

  it("pairRequest", async () => {
    const seed = randomSeed();
    trace.seed = seed;
    const [req, st] = await Enclave.pairRequest();
    expect(st).toBe(Status.Success);
    expect(req).toBeDefined();
    assertReviewed();
  });

  it("pairAccept", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;
    const [req, rst] = asDHKEReq(new Uint8Array(32).fill(3));
    expect(rst).toBe(Status.Success);
    if (req === undefined) return;
    const [resp, st] = await e.pairAccept(req, []);
    expect(st).toBe(Status.Success);
    expect(resp).toBeDefined();
    assertReviewed();
  });

  it("spawnSyncWorker", () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;
    const w = e.spawnSyncWorker({ id: 1 });
    expect(w).toBeDefined();
    assertReviewed();
  });

  it("deriveCipher", () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;
    const c = e.deriveCipher(new Uint8Array(8), "both");
    expect(c.encrypt).toBeDefined();
    assertReviewed();
  });

  it("deriveIdentity", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    trace.seed = seed;
    const idnt = await e.deriveIdentity("test", 0);
    expect(idnt.publicKey).toBeDefined();
    assertReviewed();
  });
});
