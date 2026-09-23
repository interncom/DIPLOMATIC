// Iron Law: imported functions must not receive the seed, a copy, or
// framed plaintext (seed bytes embedded in a larger buffer).
// File-local / #private calls are invisible. ESM named imports are only
// intercepted if the spy is installed via vi.mock (hoisted).
// Class methods (Encoder) are wrapped via prototype spies.

import { blake3 } from "@noble/hashes/blake3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { btoh, bytesEqual } from "../src/shared/binary";
import { Encoder } from "../src/shared/codec";
import { Status } from "../src/shared/consts";
import { asMasterSeed, Enclave } from "../src/shared/crypto/enclave";
import { asDHKEReq } from "../src/shared/crypto/pairing";
import {
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
  callerSrc: string;
  why: string;
};

// Permitted Enclave caller → imported callee.
// src = blake3(callee.toString)[:16]; callerSrc = blake3(Enclave method.toString)[:16].
const permits: Permit[] = [
  {
    caller: "sealWithPasskey",
    callee: "NobleCrypto.encryptXSalsa20Poly1305Combined",
    how: "exact",
    src: "079455f96cc75fbb6626d0377048af4f",
    callerSrc: "10c1d7ef9ba6148e5aa1c586e3cf1c00",
    why: "To encrypt the master with a KEK derived from passkey PRF.",
  },
  {
    caller: "fingerprint",
    callee: "derivation.deriveKey",
    how: "exact",
    src: "0de5207b092b952756705bc0fc7f250d",
    callerSrc: "fcd3b151aeb45bf96faab4a8a3ee8bf8",
    why: "To derive the paper-check digest from the master via the fingerprint PDK.",
  },
  {
    caller: "fingerprint",
    callee: "NobleCrypto.blake3",
    how: "exact",
    src: "ac2d00162c47b0171aee8576da4a9689",
    callerSrc: "fcd3b151aeb45bf96faab4a8a3ee8bf8",
    why: "PDK derivation hashes the master with a purpose context (BLAKE3 KDF).",
  },
  {
    caller: "deriveIdentity",
    callee: "derivation.deriveKey",
    how: "exact",
    src: "0de5207b092b952756705bc0fc7f250d",
    callerSrc: "faf6a0c3cf88a0658f668bad4f5383ed",
    why: "To derive an identity child from the master via the identity PDK and KDM.",
  },
  {
    caller: "deriveIdentity",
    callee: "NobleCrypto.blake3",
    how: "exact",
    src: "ac2d00162c47b0171aee8576da4a9689",
    callerSrc: "faf6a0c3cf88a0658f668bad4f5383ed",
    why: "PDK derivation hashes the master with a purpose context (BLAKE3 KDF).",
  },
  {
    caller: "spawnSyncWorker",
    callee: "spawn.postToDiplomaticWorker",
    how: "exact",
    src: "5af866aa6e511c9ee3df323202b50e08",
    callerSrc: "71ce459744d6cb669f64751e8cfaa706",
    why: "To inject seed into Web Worker we build to base64 blob ourselves.",
  },
  {
    caller: "pairAccept",
    callee: "NobleCrypto.encryptXSalsa20Poly1305Combined",
    how: "embedded",
    src: "079455f96cc75fbb6626d0377048af4f",
    callerSrc: "f5b34952f9511057940f52aa5d62a59a",
    why: "To encrypt pair package (including seed) with DHKE-negotiated shared key.",
  },
  {
    caller: "bind",
    callee: "derivation.deriveKey",
    how: "exact",
    src: "0de5207b092b952756705bc0fc7f250d",
    callerSrc: "24b3cbb41b2ad686584c15d52a4ad727",
    why: "To derive a bind-tag child from the master (PDK keyed by credId).",
  },
  {
    caller: "bind",
    callee: "NobleCrypto.blake3",
    how: "exact",
    src: "ac2d00162c47b0171aee8576da4a9689",
    callerSrc: "24b3cbb41b2ad686584c15d52a4ad727",
    why: "PDK derivation hashes the master with a purpose context (BLAKE3 KDF).",
  },
  {
    caller: "bind",
    callee: "NobleCrypto.encryptXSalsa20Poly1305Combined",
    how: "exact",
    src: "079455f96cc75fbb6626d0377048af4f",
    callerSrc: "24b3cbb41b2ad686584c15d52a4ad727",
    why: "To encrypt the master with KEK derived from passkey PRF.",
  },
  {
    caller: "sealWithIkm",
    callee: "NobleCrypto.encryptXSalsa20Poly1305Combined",
    how: "exact",
    src: "079455f96cc75fbb6626d0377048af4f",
    callerSrc: "a40b76baa8edc592ba346492c6d3bb67",
    why: "To encrypt the master with a KEK derived from caller-supplied PRF IKM.",
  },
  {
    caller: "fromRandom",
    callee: "NobleCrypto.blake3",
    how: "embedded",
    src: "ac2d00162c47b0171aee8576da4a9689",
    callerSrc: "41b560c907d44ad9a1cef043cf24e1c9",
    why: "To mix OS CSPRNG with mandatory user-space entropy (musec) into the master.",
  },
  {
    caller: "persistToLargeBlob",
    callee: "cryptoLargeBlob.writeLargeBlob",
    how: "embedded",
    src: "9c8cd6b0f93d95f04895afc1ee35606a",
    callerSrc: "d103cc60a7379516a76ebba8bfd217e3",
    why: "To UV-write IdentityBundle wire (master seed, then host rows) into largeBlob.",
  },
];

const { trace, wrapFns, wrapProto, origByFn, srcHex } = vi.hoisted(() => {
  const trace: {
    seed: Uint8Array | undefined;
    caller: string | undefined;
    hits: Hit[];
    osSeed: Uint8Array | undefined;
  } = {
    seed: undefined,
    caller: undefined,
    hits: [],
    osSeed: undefined,
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

// Enclave public method for a trace caller name (instance, else static).
function enclaveFn(
  name: string,
): ((...args: never[]) => unknown) | undefined {
  const inst = Object.getOwnPropertyDescriptor(Enclave.prototype, name);
  if (inst !== undefined && typeof inst.value === "function") return inst.value;
  const stat = Object.getOwnPropertyDescriptor(Enclave, name);
  if (stat !== undefined && typeof stat.value === "function") return stat.value;
  return undefined;
}

// Fails on unpermitted sinks or changed bodies; prints permit lines to paste.
function assertPermitted() {
  const lines: string[] = [];
  for (const hit of trace.hits) {
    const orig = origByFn.get(hit.callee);
    const hex = orig === undefined ? undefined : srcHex(orig);
    const callerOrig = enclaveFn(hit.caller);
    const callerHex = callerOrig === undefined ? undefined : srcHex(callerOrig);
    const permit = permits.find((p) =>
      p.caller === hit.caller && p.callee === hit.callee && p.how === hit.how
    );
    if (hex === undefined) {
      lines.push(
        `unpermitted ${hit.caller} → ${hit.callee} (${hit.how}): no original to hash`,
      );
      continue;
    }
    if (callerHex === undefined) {
      lines.push(
        `unpermitted ${hit.caller} → ${hit.callee} (${hit.how}): no Enclave method to hash`,
      );
      continue;
    }
    const row =
      `{ caller: ${JSON.stringify(hit.caller)}, ` +
      `callee: ${JSON.stringify(hit.callee)}, ` +
      `how: ${JSON.stringify(hit.how)}, ` +
      `src: ${JSON.stringify(hex)}, ` +
      `callerSrc: ${JSON.stringify(callerHex)}, why: "…" },`;
    if (permit === undefined) {
      lines.push(
        `unpermitted ${hit.caller} → ${hit.callee} (${hit.how})\n` +
          `  src: ${hex}\n` +
          `  callerSrc: ${callerHex}\n` +
          `  add to permits in web/test/enclave.test.ts (fill in why):\n    ${row}`,
      );
    } else if (permit.src !== hex) {
      lines.push(
        `${hit.caller} → ${hit.callee} (${hit.how}) callee source changed\n` +
          `  was: ${permit.src}\n` +
          `  now: ${hex}\n` +
          `  update permit src:\n    ${row}`,
      );
    } else if (permit.callerSrc !== callerHex) {
      lines.push(
        `${hit.caller} → ${hit.callee} (${hit.how}) caller source changed\n` +
          `  was: ${permit.callerSrc}\n` +
          `  now: ${callerHex}\n` +
          `  update permit callerSrc:\n    ${row}`,
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
  const blob = new Uint8Array(33);
  blob.fill(1, 0, 32);
  return wrapFns("largeBlob", orig, {
    largeBlobRead: async () => ok({ blob: blob.slice(), credId: credId.slice() }),
    largeBlobCreateCred: async () => ok(credId.slice()),
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

vi.mock("../src/shared/crypto/derivation", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/crypto/derivation")
  >();
  return wrapFns("derivation", orig);
});

vi.mock("../src/shared/crypto/entropy", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/crypto/entropy")
  >();
  return wrapFns("entropy", orig);
});

vi.mock("../src/shared/crypto/largeBlob", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/crypto/largeBlob")
  >();
  return wrapFns("cryptoLargeBlob", orig);
});

vi.mock("../src/shared/crypto/noble", async (importOriginal) => {
  const orig = await importOriginal<
    typeof import("../src/shared/crypto/noble")
  >();
  return wrapFns("NobleCrypto", orig, {
    gen256BitSecureRandomSeed: async () => {
      const os = trace.osSeed;
      if (os !== undefined) return os;
      return await orig.gen256BitSecureRandomSeed();
    },
  });
});

function randomSeed(): MasterSeed {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const [seed, st] = asMasterSeed(bytes);
  if (st !== Status.Success) throw new Error(`seed ${st}`);
  return seed;
}

function arm(caller: string, seed: MasterSeed) {
  trace.caller = caller;
  trace.seed = seed;
}

function enclaveOf(seed: MasterSeed): Enclave {
  const [e, st] = Enclave.fromBytes(seed);
  if (st !== Status.Success) throw new Error(`enclave ${st}`);
  return e;
}

function stubNav(credentials: { create?: unknown; get?: unknown }) {
  const g = globalThis as {
    navigator?: { credentials?: unknown };
    PublicKeyCredential?: unknown;
    location?: { hostname: string };
  };
  if (g.navigator !== undefined) {
    Object.defineProperty(g.navigator, "credentials", {
      configurable: true,
      writable: true,
      value: credentials,
    });
  } else {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { credentials },
    });
  }
  g.PublicKeyCredential = class {};
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: { hostname: "localhost" },
  });
}

function stubWrittenGet(credId: Uint8Array) {
  const get = vi.fn().mockResolvedValue({
    type: "public-key",
    rawId: credId,
    response: {},
    getClientExtensionResults: () => ({ largeBlob: { written: true } }),
  });
  stubNav({ create: vi.fn(), get });
}

function stubPrfGet(credId: Uint8Array, prfFill = 2) {
  const prf = new Uint8Array(32).fill(prfFill);
  const get = vi.fn().mockResolvedValue({
    type: "public-key",
    rawId: credId,
    response: {},
    getClientExtensionResults: () => ({
      prf: {
        results: {
          first: prf.buffer.slice(prf.byteOffset, prf.byteOffset + 32),
        },
      },
    }),
  });
  stubNav({ create: vi.fn(), get });
}

const SKIP = new Set(["constructor", "prototype", "length", "name"]);

// Own function keys on a constructor or prototype (not private slots).
function publicFns(obj: object): string[] {
  return Object.getOwnPropertyNames(obj).filter((k) => {
    if (SKIP.has(k)) return false;
    const d = Object.getOwnPropertyDescriptor(obj, k);
    return typeof d?.value === "function";
  });
}

const traces: Record<string, () => void | Promise<void>> = {
  fromBytes() {
    const seed = randomSeed();
    arm("fromBytes", seed);
    const [e, st] = Enclave.fromBytes(seed);
    expect(st).toBe(Status.Success);
    expect(e).toBeDefined();
    assertPermitted();
  },
  async fromRandom() {
    const seed = randomSeed();
    arm("fromRandom", seed);
    trace.osSeed = seed;
    const musec = new Uint8Array(32).fill(9);
    const [e, st] = await Enclave.fromRandom(musec);
    expect(st).toBe(Status.Success);
    expect(e).toBeDefined();
    assertPermitted();
  },
  async sealWithPasskey() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    const credId = new Uint8Array(16).fill(7);
    stubPrfGet(credId);
    arm("sealWithPasskey", seed);
    const [out, st] = await e.sealWithPasskey({
      rpId: "localhost",
      credId,
      salt: DEFAULT_PRF_SALT,
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertPermitted();
  },
  async bind() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    const credId = new Uint8Array(16).fill(7);
    stubPrfGet(credId);
    arm("bind", seed);
    const [out, st] = await e.bind({
      rpId: "localhost",
      credId,
      salt: DEFAULT_PRF_SALT,
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertPermitted();
  },
  async unsealWithPasskey() {
    const seed = randomSeed();
    const credId = new Uint8Array(16).fill(7);
    stubPrfGet(credId);
    arm("unsealWithPasskey", seed);
    const [sealed, sst] = asSealedMasterKey(
      new Uint8Array(SEALED_MASTER_KEY_LEN),
    );
    expect(sst).toBe(Status.Success);
    if (sealed === undefined) return;
    const [, st] = await Enclave.unsealWithPasskey(
      [{ sealedMaster: sealed, credId }],
      { rpId: "localhost", salt: DEFAULT_PRF_SALT },
    );
    expect(st).not.toBe(Status.Success);
    assertPermitted();
  },
  async sealWithIkm() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    const ikm = new Uint8Array(32).fill(3);
    arm("sealWithIkm", seed);
    const [out, st] = await e.sealWithIkm(ikm);
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertPermitted();
  },
  async unsealWithIkm() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    const ikm = new Uint8Array(32).fill(3);
    const [sealed, sst] = await e.sealWithIkm(ikm.slice());
    expect(sst).toBe(Status.Success);
    if (sealed === undefined) return;
    arm("unsealWithIkm", seed);
    const [opened, st] = await Enclave.unsealWithIkm(sealed, ikm.slice());
    expect(st).toBe(Status.Success);
    expect(opened).toBeDefined();
    assertPermitted();
  },
  async persistToLargeBlob() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("persistToLargeBlob", seed);
    const credId = new Uint8Array(16).fill(7);
    stubWrittenGet(credId);
    const [id, st] = await e.persistToLargeBlob([], { credId });
    expect(st).toBe(Status.Success);
    expect(id).toBeDefined();
    assertPermitted();
  },
  async fromLargeBlob() {
    const seed = randomSeed();
    arm("fromLargeBlob", seed);
    const [out, st] = await Enclave.fromLargeBlob({
      rpId: "localhost",
      credId: new Uint8Array(16).fill(7),
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    assertPermitted();
  },
  async clearLargeBlob() {
    const seed = randomSeed();
    arm("clearLargeBlob", seed);
    const credId = new Uint8Array(16).fill(7);
    stubWrittenGet(credId);
    const st = await Enclave.clearLargeBlob(credId, { rpId: "localhost" });
    expect(st).toBe(Status.Success);
    assertPermitted();
  },
  async dumpToTty() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("dumpToTty", seed);
    const st = await e.dumpToTty();
    expect(st).toBe(Status.NotImplemented);
    assertPermitted();
  },
  async fingerprint() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("fingerprint", seed);
    const [fp, st] = await e.fingerprint();
    expect(st).toBe(Status.Success);
    expect(fp).toBeDefined();
    assertPermitted();
  },
  async pairRequest() {
    const seed = randomSeed();
    arm("pairRequest", seed);
    const [req, st] = await Enclave.pairRequest();
    expect(st).toBe(Status.Success);
    expect(req).toBeDefined();
    assertPermitted();
  },
  async pairAccept() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("pairAccept", seed);
    const [req, rst] = asDHKEReq(new Uint8Array(32).fill(3));
    expect(rst).toBe(Status.Success);
    if (req === undefined) return;
    const [resp, st] = await e.pairAccept(req, [], {
      userControlsBothSidesOfPair: true,
    });
    expect(st).toBe(Status.Success);
    expect(resp).toBeDefined();
    assertPermitted();
  },
  spawnSyncWorker() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("spawnSyncWorker", seed);
    const w = e.spawnSyncWorker({ id: 1 });
    expect(w).toBeDefined();
    assertPermitted();
  },
  deriveCipher() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("deriveCipher", seed);
    const c = e.deriveCipher(new Uint8Array(8), "both");
    expect(c.encrypt).toBeDefined();
    assertPermitted();
  },
  async deriveIdentity() {
    const seed = randomSeed();
    const e = enclaveOf(seed);
    arm("deriveIdentity", seed);
    const [idnt, ist] = await e.deriveIdentity("test", 0);
    expect(ist).toBe(Status.Success);
    expect(idnt?.publicKey).toBeDefined();
    assertPermitted();
  },
};

describe("Enclave imported-callee seed trace", () => {
  it("covers every public method", () => {
    const pub = [...publicFns(Enclave), ...publicFns(Enclave.prototype)].sort();
    expect(Object.keys(traces).sort()).toEqual(pub);
  });

  beforeEach(() => {
    wrapProto("Encoder", Encoder.prototype);
  });

  afterEach(() => {
    trace.seed = undefined;
    trace.caller = undefined;
    trace.hits = [];
    trace.osSeed = undefined;
    vi.restoreAllMocks();
  });

  for (const [name, fn] of Object.entries(traces)) {
    it(name, fn);
  }
});
