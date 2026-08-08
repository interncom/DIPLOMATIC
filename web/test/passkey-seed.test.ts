import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLargeBlobCred,
  PasskeySeedStore,
  readLargeBlobSeed,
  writeLargeBlobSeed,
} from "../src/passkey/seed";
import type { MasterSeed } from "../src/shared/types";

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
    expect(arg.publicKey.extensions.largeBlob.support).toBe("required");
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
    expect(arg.publicKey.extensions.largeBlob.write).toEqual(seedOf(1));
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
