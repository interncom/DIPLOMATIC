import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultWebAuthnRpId,
  LargeBlob,
  PasskeySeedStore,
} from "../src/passkey/seed";
import crypto from "../src/crypto";
import { Status } from "../src/shared/consts";
import type { MasterSeed } from "../src/shared/seed";

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
    getClientExtensionResults: () => ext } as PublicKeyCredential;
}

describe("LargeBlob", () => {
  const credId = new Uint8Array(16).fill(7);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("createCred returns rawId when supported", async () => {
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { supported: true } }),
    );
    vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const [id, st] = await LargeBlob.createCred({ rpId: "localhost" });
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
    vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "life.interncom.org" });

    const [, st] = await LargeBlob.createCred();
    expect(st).toBe(Status.Success);
    const arg = create.mock.calls[0][0];
    expect(arg.publicKey.rp.id).toBe("life.interncom.org");
  });

  it("createCred fails when authenticator omits largeBlob", async () => {
    const create = vi.fn().mockResolvedValue(mockCred(credId.buffer, {}));
    vi.stubGlobal("navigator", { credentials: { create, get: vi.fn() } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const [, st] = await LargeBlob.createCred({ rpId: "localhost" });
    expect(st).toBe(Status.HostError);
  });

  it("writeSeed requires written:true", async () => {
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { largeBlob: { written: true } }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const st = await LargeBlob.writeSeed(credId, seedOf(1), {
      rpId: "localhost" });
    expect(st).toBe(Status.Success);
    const arg = get.mock.calls[0][0];
    expect(arg.publicKey.extensions.largeBlob.write).toEqual(seedOf(1));
  });

  it("readSeed returns seed bytes", async () => {
    const seed = seedOf(9);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32) } }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const [out, st] = await LargeBlob.readSeed(credId, { rpId: "localhost" });
    expect(st).toBe(Status.Success);
    expect(out).toEqual(seed);
  });

  it("discover omits allowCredentials and returns seed+credId", async () => {
    const seed = seedOf(4);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32) } }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const [out, st] = await LargeBlob.discover({ rpId: "localhost" });
    expect(st).toBe(Status.Success);
    expect(out!.seed).toEqual(seed);
    expect(out!.credId).toEqual(credId);
    const arg = get.mock.calls[0][0];
    expect(arg.publicKey.allowCredentials).toBeUndefined();
    expect(arg.publicKey.extensions.largeBlob.read).toBe(true);
  });

  it("discover fails on wiped zero seed", async () => {
    const zeros = seedOf(0);
    const get = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, {
        largeBlob: {
          blob: zeros.buffer.slice(zeros.byteOffset, zeros.byteOffset + 32) } }),
    );
    vi.stubGlobal("navigator", { credentials: { create: vi.fn(), get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const [, st] = await LargeBlob.discover({ rpId: "localhost" });
    expect(st).toBe(Status.MissingSeed);
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
            blob: seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32) } }),
      );
    vi.stubGlobal("navigator", { credentials: { create, get } });
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.stubGlobal("location", { hostname: "localhost" });

    const store = new PasskeySeedStore({ crypto, rpId: "localhost" });
    const enc1 = await store.save(seed, { persist: true });
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
