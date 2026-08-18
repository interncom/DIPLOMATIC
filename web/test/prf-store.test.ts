import { afterEach, describe, expect, it, vi } from "vitest";
import { Enclave } from "../src/shared/crypto/enclave";
import { Status } from "../src/shared/consts";
import { DEFAULT_PRF_SALT, DEFAULT_PRF_USER_NAME } from "../src/shared/webauthn/prf";
import {
  KEYRING_MAX,
  keyringKind,
  keyringLabel,
  type Keyring,
  PrfSeedStore,
} from "../src/passkey/prf-store";

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(new Uint8Array(32).fill(fill));
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclaveOf ${st}`);
  }
  return e;
}

function mockCred(
  rawId: ArrayBuffer,
  ext: AuthenticationExtensionsClientOutputs,
  attachment: AuthenticatorAttachment = "platform",
): PublicKeyCredential {
  return {
    type: "public-key",
    id: "x",
    rawId,
    response: {} as AuthenticatorAssertionResponse,
    authenticatorAttachment: attachment,
    getClientExtensionResults: () => ext,
  } as PublicKeyCredential;
}

function stubNavigator(credentials: { create?: unknown; get?: unknown }) {
  const g = globalThis as {
    navigator?: { credentials?: unknown; userAgent?: string };
    PublicKeyCredential?: unknown;
    location?: { hostname: string };
  };
  if (g.navigator !== undefined) {
    Object.defineProperty(g.navigator, "credentials", {
      configurable: true,
      value: credentials,
    });
  } else {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: { credentials, userAgent: "Macintosh" },
    });
  }
  g.PublicKeyCredential = class {};
  if (g.location === undefined || g.location.hostname === undefined) {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { hostname: "localhost" },
    });
  }
}

function stubPrfGet(prfFill: number, credFill = 7) {
  const credId = new Uint8Array(16).fill(credFill);
  const prf = new Uint8Array(32).fill(prfFill);
  const get = vi.fn().mockResolvedValue(
    mockCred(credId.buffer, {
      prf: {
        results: {
          first: prf.buffer.slice(prf.byteOffset, prf.byteOffset + 32),
        },
      },
    }),
  );
  stubNavigator({ create: vi.fn(), get });
  return { get, credId };
}

describe("PrfSeedStore keyring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bindAndSave persists a flat entry + credId", async () => {
    const { credId } = stubPrfGet(3);
    let saved: Keyring | undefined;
    const store = new PrfSeedStore({
      rpId: "localhost",
      persistKeyring: (r) => {
        saved = r;
      },
    });
    const [enc, st] = await store.bindAndSave(enclaveOf(9), {
      salt: DEFAULT_PRF_SALT,
      credId,
      createCredIfNeeded: false,
      nick: "Laptop",
    });
    expect(st).toBe(Status.Success);
    expect(enc).toBeDefined();
    expect(saved?.entries).toHaveLength(1);
    expect(saved?.entries[0]?.credId).toEqual(credId);
    expect(saved?.entries[0]?.nick).toBe("Laptop");
    expect(saved?.entries[0]?.type).toBe("prf");
    expect(saved?.entries[0]?.tag.byteLength).toBe(32);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.nick).toBe("Laptop");
  });

  it("second binding appends; unlock allowCredentials has both", async () => {
    const first = stubPrfGet(3, 7);
    let saved: Keyring | undefined;
    const store = new PrfSeedStore({
      rpId: "localhost",
      persistKeyring: (r) => {
        saved = r;
      },
    });
    const enc = enclaveOf(9);
    const [, wst] = await store.bindAndSave(enc, {
      salt: DEFAULT_PRF_SALT,
      credId: first.credId,
      createCredIfNeeded: false,
      nick: "Passkey",
    });
    expect(wst).toBe(Status.Success);

    const createId = new Uint8Array(16).fill(11);
    const prf2 = new Uint8Array(32).fill(5);
    const create = vi.fn().mockResolvedValue(
      mockCred(createId.buffer, { prf: { enabled: true } }, "cross-platform"),
    );
    const get2 = vi.fn().mockResolvedValue(
      mockCred(
        createId.buffer,
        {
          prf: {
            results: {
              first: prf2.buffer.slice(prf2.byteOffset, prf2.byteOffset + 32),
            },
          },
        },
        "cross-platform",
      ),
    );
    stubNavigator({ create, get: get2 });

    const [, ast] = await store.bindAndSave(enc, {
      salt: DEFAULT_PRF_SALT,
      createCredIfNeeded: true,
      nick: "Yubi",
      authenticatorAttachment: "cross-platform",
    });
    expect(ast).toBe(Status.Success);
    expect(create).toHaveBeenCalledOnce();
    const pub = create.mock.calls[0][0].publicKey;
    expect(pub.excludeCredentials).toHaveLength(1);
    expect(pub.user.displayName).toBe("Yubi");
    expect(pub.user.name).toBe(DEFAULT_PRF_USER_NAME);
    expect(saved?.entries).toHaveLength(2);
    expect(saved?.entries[0]?.credId).toEqual(first.credId);
    expect(saved?.entries[1]?.credId).toEqual(createId);

    const getUnlock = vi.fn().mockResolvedValue(
      mockCred(
        createId.buffer,
        {
          prf: {
            results: {
              first: prf2.buffer.slice(prf2.byteOffset, prf2.byteOffset + 32),
            },
          },
        },
        "cross-platform",
      ),
    );
    stubNavigator({ create: vi.fn(), get: getUnlock });
    const [opened, ust] = await store.unlock();
    expect(ust).toBe(Status.Success);
    expect(opened).toBeDefined();
    const allow = getUnlock.mock.calls[0][0].publicKey.allowCredentials;
    expect(allow).toHaveLength(2);
    const orig = await enc.deriveIdentity("test", 0);
    const next = await opened?.deriveIdentity("test", 0);
    expect(next?.publicKey).toEqual(orig.publicKey);
    expect(store.list()[1]?.lastUsedAt).toBeDefined();
  });

  it("bindAndSave refuses a different master", async () => {
    const first = stubPrfGet(3, 7);
    const store = new PrfSeedStore({
      rpId: "localhost",
      persistKeyring: () => undefined,
    });
    const [, wst] = await store.bindAndSave(enclaveOf(9), {
      salt: DEFAULT_PRF_SALT,
      credId: first.credId,
      createCredIfNeeded: false,
    });
    expect(wst).toBe(Status.Success);

    stubPrfGet(4, 8);
    const [, bst] = await store.bindAndSave(enclaveOf(1), {
      salt: DEFAULT_PRF_SALT,
      createCredIfNeeded: false,
      credId: new Uint8Array(16).fill(8),
    });
    expect(bst).toBe(Status.InvalidParam);
    expect(store.list()).toHaveLength(1);
  });

  it("rename and remove", async () => {
    const { credId } = stubPrfGet(3);
    const store = new PrfSeedStore({
      rpId: "localhost",
      persistKeyring: () => undefined,
    });
    const [, st] = await store.bindAndSave(enclaveOf(9), {
      salt: DEFAULT_PRF_SALT,
      credId,
      createCredIfNeeded: false,
    });
    expect(st).toBe(Status.Success);
    const [, rst] = await store.rename(credId, "  Work  ");
    expect(rst).toBe(Status.Success);
    expect(store.list()[0]?.nick).toBe("Work");
    const [, dst] = await store.remove(credId);
    expect(dst).toBe(Status.Success);
    expect(store.list()).toHaveLength(0);
    expect(store.keyring).toBeUndefined();
  });

  it("refuses a ninth binding", async () => {
    const first = stubPrfGet(3, 1);
    const store = new PrfSeedStore({
      rpId: "localhost",
      persistKeyring: () => undefined,
    });
    const enc = enclaveOf(9);
    const [, wst] = await store.bindAndSave(enc, {
      salt: DEFAULT_PRF_SALT,
      credId: first.credId,
      createCredIfNeeded: false,
    });
    expect(wst).toBe(Status.Success);
    const ring = store.keyring;
    if (ring === undefined) return;
    const src = ring.entries[0];
    if (src === undefined) return;
    const filled: Keyring = {
      salt: ring.salt,
      entries: Array.from({ length: KEYRING_MAX }, (_, i) => ({
        ...src,
        credId: new Uint8Array(16).fill(i + 1),
      })),
    };
    const full = new PrfSeedStore({
      rpId: "localhost",
      keyring: filled,
      persistKeyring: () => undefined,
    });
    const create = vi.fn();
    stubNavigator({ create, get: vi.fn() });
    const [, ost] = await full.bindAndSave(enc, { createCredIfNeeded: true });
    expect(ost).toBe(Status.VarLimitExceeded);
    expect(create).not.toHaveBeenCalled();
  });

  it("keyringLabel prefers nick then kind", () => {
    const credId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(keyringLabel({
      type: "prf",
      credId,
      nick: "Home",
      enrolledAt: 0,
      attachment: "platform",
      enrolledOs: "macos",
    })).toBe("Home");
    expect(keyringKind({
      type: "prf",
      credId,
      enrolledAt: 0,
      attachment: "platform",
      enrolledOs: "macos",
    })).toBe("Apple Passkey");
    expect(keyringKind({
      type: "prf",
      credId,
      enrolledAt: 0,
      attachment: "cross-platform",
    })).toBe("Security key");
  });
});
