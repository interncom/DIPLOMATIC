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

type Hit = {
  caller: string;
  callee: string;
  how: "exact" | "embedded";
};
type Permit = {
  caller: string;
  callee: string;
  how: Hit["how"];
  src: string;
  why: string;
};

// Permitted Enclave caller → imported callee (src = blake3(toString)[:16] hex).
const permits: Permit[] = [
  {
    caller: "sealWithPasskey",
    callee: "NobleCrypto.encryptXSalsa20Poly1305Combined",
    how: "exact",
    src: "c87390f5b54c28fe7c228a7325c42aee",
    why: "To encrypt the master with a KEK derived from passkey PRF.",
  },
  {
    caller: "deriveIdentity",
    callee: "NobleCrypto.blake3",
    how: "embedded",
    src: "f6f104ad232958bb7949fb63bf3d6580",
    why: "To derive a sub-key from the provided KDM (keypath and index).",
  },
  {
    caller: "spawnSyncWorker",
    callee: "spawn.postToDiplomaticWorker",
    how: "exact",
    src: "5af866aa6e511c9ee3df323202b50e08",
    why: "To inject seed into Web Worker we build to base64 blob ourselves.",
  },
];

const { trace, wrapFns, wrapProto, origByFn, srcHex } = vi.hoisted(() => {
  const trace: {
    seed: Uint8Array | undefined;
    caller: string | undefined;
    hits: Hit[];
  } = {
    seed: undefined,
    caller: undefined,
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

  function record(callee: string, args: unknown[]) {
    const seed = trace.seed;
    const caller = trace.caller;
    if (seed === undefined || caller === undefined) return;
    const how = valHow(args, seed, new WeakSet());
    if (how !== undefined) trace.hits.push({ caller, callee, how });
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

// Fails on unpermitted sinks or changed bodies; prints permit lines to paste.
function assertPermitted() {
  const lines: string[] = [];
  for (const hit of trace.hits) {
    const orig = origByFn.get(hit.callee);
    const hex = orig === undefined ? undefined : srcHex(orig);
    const permit = permits.find((p) =>
      p.caller === hit.caller && p.callee === hit.callee && p.how === hit.how
    );
    if (hex === undefined) {
      lines.push(
        `unpermitted ${hit.caller} → ${hit.callee} (${hit.how}): no original to hash`,
      );
      continue;
    }
    const row =
      `{ caller: ${JSON.stringify(hit.caller)}, ` +
      `callee: ${JSON.stringify(hit.callee)}, ` +
      `how: ${JSON.stringify(hit.how)}, ` +
      `src: ${JSON.stringify(hex)}, why: "…" },`;
    if (permit === undefined) {
      lines.push(
        `unpermitted ${hit.caller} → ${hit.callee} (${hit.how})\n` +
          `  src: ${hex}\n` +
          `  add to permits in web/test/enclave.test.ts (fill in why):\n    ${row}`,
      );
    } else if (permit.src !== hex) {
      lines.push(
        `${hit.caller} → ${hit.callee} (${hit.how}) source changed\n` +
          `  was: ${permit.src}\n` +
          `  now: ${hex}\n` +
          `  update permit src:\n    ${row}`,
      );
    } else if (permit.why.trim().length === 0 || permit.why === "…") {
      lines.push(
        `${hit.caller} → ${hit.callee} (${hit.how}) permit needs a why`,
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

function arm(caller: string, seed: MasterSeed) {
  trace.caller = caller;
  trace.seed = seed;
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
    trace.caller = undefined;
    trace.hits = [];
    vi.restoreAllMocks();
  });

  it("fromBytes", () => {
    const seed = randomSeed();
    arm("fromBytes", seed);
    const [e, st] = Enclave.fromBytes(seed);
    expect(st).toBe(Status.Success);
    expect(e).toBeDefined();
    assertPermitted();
  });

  it("fromRandom", async () => {
    const seed = randomSeed();
    arm("fromRandom", seed);
    vi.spyOn(NobleCrypto.prototype, "gen256BitSecureRandomSeed")
      .mockResolvedValue(seed);
    const e = await Enclave.fromRandom();
    expect(e).toBeDefined();
    assertPermitted();
  });

  it("sealWithPasskey", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("sealWithPasskey", seed);
    const [out, st] = await e.sealWithPasskey({
      rpId: "localhost",
      credId: new Uint8Array(16).fill(7),
      salt: DEFAULT_PRF_SALT,
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertPermitted();
  });

  it("bind", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("bind", seed);
    const [out, st] = await e.bind({
      rpId: "localhost",
      credId: new Uint8Array(16).fill(7),
      salt: DEFAULT_PRF_SALT,
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertPermitted();
  });

  it("unsealWithPasskey", async () => {
    const seed = randomSeed();
    arm("unsealWithPasskey", seed);
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
    assertPermitted();
  });

  it("persistToLargeBlob", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("persistToLargeBlob", seed);
    const credId = new Uint8Array(16).fill(7);
    stubWrittenGet(credId);
    const [id, st] = await e.persistToLargeBlob([], { credId });
    expect(st).toBe(Status.Success);
    expect(id).toBeDefined();
    assertPermitted();
  });

  it("fromLargeBlob", async () => {
    const seed = randomSeed();
    arm("fromLargeBlob", seed);
    const [out, st] = await Enclave.fromLargeBlob({
      rpId: "localhost",
      credId: new Uint8Array(16).fill(7),
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertPermitted();
  });

  it("clearLargeBlob", async () => {
    const seed = randomSeed();
    arm("clearLargeBlob", seed);
    const credId = new Uint8Array(16).fill(7);
    stubWrittenGet(credId);
    const st = await Enclave.clearLargeBlob(credId, { rpId: "localhost" });
    expect(st).toBe(Status.Success);
    assertPermitted();
  });

  it("pairRequest", async () => {
    const seed = randomSeed();
    arm("pairRequest", seed);
    const [req, st] = await Enclave.pairRequest();
    expect(st).toBe(Status.Success);
    expect(req).toBeDefined();
    assertPermitted();
  });

  it("pairAccept", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("pairAccept", seed);
    const [req, rst] = asDHKEReq(new Uint8Array(32).fill(3));
    expect(rst).toBe(Status.Success);
    if (req === undefined) return;
    const [resp, st] = await e.pairAccept(req, []);
    expect(st).toBe(Status.Success);
    expect(resp).toBeDefined();
    assertPermitted();
  });

  it("spawnSyncWorker", () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("spawnSyncWorker", seed);
    const w = e.spawnSyncWorker({ id: 1 });
    expect(w).toBeDefined();
    assertPermitted();
  });

  it("deriveCipher", () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("deriveCipher", seed);
    const c = e.deriveCipher(new Uint8Array(8), "both");
    expect(c.encrypt).toBeDefined();
    assertPermitted();
  });

  it("deriveIdentity", async () => {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("deriveIdentity", seed);
    const idnt = await e.deriveIdentity("test", 0);
    expect(idnt.publicKey).toBeDefined();
    assertPermitted();
  });
});
