import { afterEach, describe, expect, it, vi } from "vitest";
import { PasskeySeedStore } from "../src/passkey/seed";
import { defaultWebAuthnRpId } from "../src/shared/webauthn/common";
import { largeBlobCreateCred } from "../src/shared/webauthn/largeBlob";
import crypto from "../src/crypto";
import { Enclave } from "../src/shared/crypto/enclave";
import { Status } from "../src/shared/consts";

describe("defaultWebAuthnRpId", () => {
  it("uses the full hostname (no eTLD+1 collapse)", () => {
    expect(defaultWebAuthnRpId("life.interncom.org")).toBe("life.interncom.org");
    expect(defaultWebAuthnRpId("app.life.interncom.org")).toBe(
      "app.life.interncom.org",
    );
    expect(defaultWebAuthnRpId("interncom.org")).toBe("interncom.org");
    expect(defaultWebAuthnRpId("foo.example.co.uk")).toBe("foo.example.co.uk");
    expect(defaultWebAuthnRpId("preview.my-app.workers.dev")).toBe(
      "preview.my-app.workers.dev",
    );
  });

  it("normalizes case and trailing dots; empty → localhost", () => {
    expect(defaultWebAuthnRpId("Life.Example.COM.")).toBe("life.example.com");
    expect(defaultWebAuthnRpId("")).toBe("localhost");
    expect(defaultWebAuthnRpId("localhost")).toBe("localhost");
    expect(defaultWebAuthnRpId("127.0.0.1")).toBe("127.0.0.1");
  });
});

function seedBytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(seedBytes(fill));
  if (st !== Status.Success || e === undefined) {
    throw new Error(`enclaveOf failed ${st}`);
  }
  return e;
}

function mockCred(
  rawId: ArrayBuffer,
  ext: AuthenticationExtensionsClientOutputs,
): PublicKeyCredential {
  return {
    type: "public-key",
    id: "x",
    rawId,
    response: {} as AuthenticatorAttestationResponse,
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ext,
  } as PublicKeyCredential;
}

function stubNav(
  credentials: { create?: unknown; get?: unknown },
  hostname = "localhost",
) {
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
    value: { hostname },
  });
}

describe("largeBlob createCred (WebAuthn I/O only)", () => {
  const credId = new Uint8Array(16).fill(7);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("createCred returns rawId when supported", async () => {
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { supported: true } }),
    );
    stubNav({ create, get: vi.fn() });

    const [id, st] = await largeBlobCreateCred({ rpId: "localhost" });
    expect(st).toBe(Status.Success);
    expect(id).toEqual(credId);
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0][0];
    expect(arg.publicKey.extensions.largeBlob.support).toBe("required");
  });

  it("createCred defaults rpId to full location.hostname", async () => {
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { supported: true } }),
    );
    stubNav({ create, get: vi.fn() }, "life.interncom.org");

    const [, st] = await largeBlobCreateCred();
    expect(st).toBe(Status.Success);
    const arg = create.mock.calls[0][0];
    expect(arg.publicKey.rp.id).toBe("life.interncom.org");
  });

  it("createCred fails when authenticator omits largeBlob", async () => {
    const create = vi.fn().mockResolvedValue(mockCred(credId.buffer, {}));
    stubNav({ create, get: vi.fn() });

    const [, st] = await largeBlobCreateCred({ rpId: "localhost" });
    expect(st).toBe(Status.WebAuthnError);
  });
});

describe("Enclave largeBlob seed boundary", () => {
  const credId = new Uint8Array(16).fill(7);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persistToLargeBlob UV-writes without returning seed", async () => {
    let writeRaw: ArrayBuffer | undefined;
    const get = vi.fn().mockImplementation((arg: {
      publicKey: { extensions: { largeBlob: { write: ArrayBuffer } } };
    }) => {
      writeRaw = arg.publicKey.extensions.largeBlob.write.slice(0);
      return Promise.resolve(
        mockCred(credId.buffer, { largeBlob: { written: true } }),
      );
    });
    stubNav({ create: vi.fn(), get });

    const [id, st] = await enclaveOf(1).persistToLargeBlob([], {
      rpId: "localhost",
      credId,
    });
    expect(st).toBe(Status.Success);
    expect(id).toEqual(credId);
    expect(get).toHaveBeenCalledOnce();
    expect(writeRaw).toBeInstanceOf(ArrayBuffer);
    if (writeRaw === undefined) return;
    // Opaque wire longer than bare seed; seed bytes must not be all-zero
    // (regression: Encoder held a ref that Enclave zeroed before result()).
    const written = new Uint8Array(writeRaw);
    expect(written.byteLength).toBeGreaterThan(32);
    expect(written.subarray(0, 32).every((b: number) => b === 0)).toBe(false);
    expect(written.subarray(0, 32).every((b: number) => b === 1)).toBe(true);
  });

  it("fromLargeBlob absorbs legacy 32-byte payload into enclave", async () => {
    const seed = seedBytes(9);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32),
        },
      }),
    );
    stubNav({ create: vi.fn(), get });

    const [out, st] = await Enclave.fromLargeBlob({
      rpId: "localhost",
      credId,
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    if (out === undefined) return;
    expect(out.credId).toEqual(credId);
    // Round-trip identity: same seed as enclaveOf(9) would derive.
    const expected = await enclaveOf(9).deriveIdentity("test", 0);
    const got = await out.enclave.deriveIdentity("test", 0);
    expect(got.publicKey).toEqual(expected.publicKey);
  });

  it("fromLargeBlob without credId is discoverable", async () => {
    const seed = seedBytes(4);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32),
        },
      }),
    );
    stubNav({ create: vi.fn(), get });

    const [out, st] = await Enclave.fromLargeBlob({
      rpId: "localhost",
    });
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    if (out === undefined) return;
    expect(out.credId).toEqual(credId);
    const expected = await enclaveOf(4).deriveIdentity("test", 0);
    const got = await out.enclave.deriveIdentity("test", 0);
    expect(got.publicKey).toEqual(expected.publicKey);
    expect(get).toHaveBeenCalledTimes(2);
    const pick = get.mock.calls[0][0];
    expect(pick.publicKey.allowCredentials).toBeUndefined();
    expect(pick.publicKey.extensions).toBeUndefined();
    const read = get.mock.calls[1][0];
    expect(read.publicKey.allowCredentials).toBeDefined();
    expect(read.publicKey.extensions.largeBlob.read).toBe(true);
  });

  it("fromLargeBlob forwards security-key hints", async () => {
    const seed = seedBytes(4);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32),
        },
      }),
    );
    stubNav({ create: vi.fn(), get });

    const [, st] = await Enclave.fromLargeBlob({
      rpId: "localhost",
      hints: ["security-key"],
    });
    expect(st).toBe(Status.Success);
    expect(get.mock.calls[0][0].publicKey.hints).toEqual(["security-key"]);
    expect(get.mock.calls[1][0].publicKey.hints).toEqual(["security-key"]);
    expect(get.mock.calls[1][0].publicKey.extensions.largeBlob.read).toBe(
      true,
    );
  });

  it("fromLargeBlob fails on wiped zero seed", async () => {
    const zeros = seedBytes(0);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: zeros.buffer.slice(zeros.byteOffset, zeros.byteOffset + 32),
        },
      }),
    );
    stubNav({ create: vi.fn(), get });

    const [, st] = await Enclave.fromLargeBlob({
      rpId: "localhost",
    });
    expect(st).toBe(Status.MissingSeed);
  });

  it("PasskeySeedStore save/unlock/load", async () => {
    const seed = seedBytes(3);
    const enc0 = enclaveOf(3);
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { supported: true } }),
    );
    const get = vi
      .fn()
      .mockResolvedValueOnce(
        mockCred(credId.buffer, { largeBlob: { written: true } }),
      )
      .mockResolvedValueOnce(
        mockCred(credId.buffer, { largeBlob: { written: true } }),
      )
      .mockResolvedValueOnce(
        mockCred(credId.buffer, {
          largeBlob: {
            blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32),
          },
        }),
      );
    stubNav({ create, get });

    const store = new PasskeySeedStore({ rpId: "localhost" });
    const enc1 = await store.save(enc0, { persist: true });
    expect(enc1).toBeDefined();
    expect(store.credId).toEqual(credId);
    expect(await store.load()).toBe(enc1);

    await store.wipe();
    expect(store.credId).toBeUndefined();
    expect(await store.load()).toBeUndefined();

    store.setCredId(credId);
    const [enc2, ust] = await store.unlock();
    expect(ust).toBe(Status.Success);
    expect(await store.load()).toBe(enc2);
  });
});
