import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLargeBlobCred,
  defaultWebAuthnRpId,
  discoverLargeBlobSeed,
  largeBlobCapable,
  PasskeySeedStore,
  readLargeBlobSeed,
  writeLargeBlobSeed,
} from "../src/passkey/seed";
import type { MasterSeed } from "../src/shared/types";

describe("defaultWebAuthnRpId", () => {
  it("uses eTLD+1 for normal multi-label hosts", () => {
    expect(defaultWebAuthnRpId("life.interncom.org")).toBe("interncom.org");
    expect(defaultWebAuthnRpId("app.life.interncom.org")).toBe("interncom.org");
    expect(defaultWebAuthnRpId("interncom.org")).toBe("interncom.org");
  });

  it("keeps localhost and IPs", () => {
    expect(defaultWebAuthnRpId("localhost")).toBe("localhost");
    expect(defaultWebAuthnRpId("127.0.0.1")).toBe("127.0.0.1");
  });

  it("handles multi-part public suffixes", () => {
    expect(defaultWebAuthnRpId("foo.example.co.uk")).toBe("example.co.uk");
    expect(defaultWebAuthnRpId("my-app.workers.dev")).toBe("my-app.workers.dev");
    expect(defaultWebAuthnRpId("preview.my-app.workers.dev")).toBe(
      "my-app.workers.dev",
    );
  });
});

function seedOf(fill: number): MasterSeed {
  return new Uint8Array(32).fill(fill) as MasterSeed;
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

describe("passkey largeBlob seed", () => {
  const credId = new Uint8Array(16).fill(7);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("largeBlobCapable is true on Safari even when caps say false", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      vendor: "Apple Computer, Inc.",
    });
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: vi.fn().mockResolvedValue({
        "extension:largeBlob": false,
      }),
    });
    expect(await largeBlobCapable()).toBe(true);
  });

  it("largeBlobCapable is true on Safari when largeBlob key is omitted", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      vendor: "Apple Computer, Inc.",
    });
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: vi.fn().mockResolvedValue({}),
    });
    expect(await largeBlobCapable()).toBe(true);
  });

  it("largeBlobCapable respects caps on non-Safari when advertised false", async () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      vendor: "Google Inc.",
    });
    vi.stubGlobal("PublicKeyCredential", {
      getClientCapabilities: vi.fn().mockResolvedValue({
        "extension:largeBlob": false,
      }),
    });
    expect(await largeBlobCapable()).toBe(false);
  });

  it("createLargeBlobCred returns rawId when supported", async () => {
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { supported: true } }),
    );
    vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const id = await createLargeBlobCred({ rpId: "localhost" });
    expect(id).toEqual(credId);
    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0][0];
    expect(arg.publicKey.extensions.largeBlob.support).toBe("preferred");
  });

  it("createLargeBlobCred defaults rpId to eTLD+1 from location.hostname", async () => {
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { supported: true } }),
    );
    vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "life.interncom.org" });

    await createLargeBlobCred();
    const arg = create.mock.calls[0][0];
    expect(arg.publicKey.rp.id).toBe("interncom.org");
  });

  it("createLargeBlobCred rejects when authenticator omits largeBlob", async () => {
    const create = vi.fn().mockResolvedValue(mockCred(credId.buffer, {}));
    vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    await expect(createLargeBlobCred({ rpId: "localhost" })).rejects.toThrow(
      /largeBlob: unsupported by authenticator/,
    );
  });

  it("writeLargeBlobSeed requires written:true", async () => {
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { written: true } }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    await writeLargeBlobSeed(credId, seedOf(1), { rpId: "localhost" });
    const arg = get.mock.calls[0][0];
    // write is ArrayBuffer for Safari BufferSource compatibility
    expect(new Uint8Array(arg.publicKey.extensions.largeBlob.write)).toEqual(
      seedOf(1),
    );
  });

  it("readLargeBlobSeed returns seed bytes", async () => {
    const seed = seedOf(9);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: { blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32) },
      }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const out = await readLargeBlobSeed(credId, { rpId: "localhost" });
    expect(out).toEqual(seed);
  });

  it("discoverLargeBlobSeed omits allowCredentials and returns seed+credId", async () => {
    const seed = seedOf(4);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32),
        },
      }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const out = await discoverLargeBlobSeed({ rpId: "localhost" });
    expect(out.seed).toEqual(seed);
    expect(out.credId).toEqual(credId);
    const arg = get.mock.calls[0][0];
    expect(arg.publicKey.allowCredentials).toBeUndefined();
    expect(arg.publicKey.extensions.largeBlob.read).toBe(true);
  });

  it("discoverLargeBlobSeed rejects wiped zero seed", async () => {
    const zeros = seedOf(0);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: zeros.buffer.slice(zeros.byteOffset, zeros.byteOffset + 32),
        },
      }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    await expect(discoverLargeBlobSeed({ rpId: "localhost" })).rejects.toThrow(
      /seed was cleared/,
    );
  });

  it("PasskeySeedStore save/unlock/load", async () => {
    const seed = seedOf(3);
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
    vi.stubGlobal("navigator", { credentials: { create, get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const store = new PasskeySeedStore({ rpId: "localhost" });
    // PasskeySeedStore writes largeBlob only with persist: true.
    const enc1 = await store.save(seed, { persist: true });
    expect(enc1).toBeDefined();
    expect(store.credId).toEqual(credId);
    expect(await store.load()).toBe(enc1);

    // wipe overwrites largeBlob then drops credId.
    await store.wipe();
    expect(store.credId).toBeUndefined();
    expect(await store.load()).toBeUndefined();

    store.setCredId(credId);
    const enc2 = await store.unlock();
    expect(await store.load()).toBe(enc2);
  });
});
