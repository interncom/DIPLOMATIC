import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "../src/crypto";
import { Enclave } from "../src/shared/crypto/enclave";
import { Status } from "../src/shared/consts";
import { DEFAULT_PRF_SALT } from "../src/shared/webauthn/prf";
import {
  PrfSeedStore,
  type PrfSeedMeta,
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
): PublicKeyCredential {
  return {
    type: "public-key",
    id: "x",
    rawId,
    response: {} as AuthenticatorAssertionResponse,
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ext,
  } as PublicKeyCredential;
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
    } as AuthenticationExtensionsClientOutputs),
  );
  (globalThis as { navigator?: unknown }).navigator = {
    credentials: { create: vi.fn(), get },
  };
  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential =
    class {};
  (globalThis as { location?: unknown }).location = { hostname: "localhost" };
  return { get, credId };
}

describe("PrfSeedStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wrapAndSave persists sealed meta + credId", async () => {
    const { credId } = stubPrfGet(3);
    let saved: PrfSeedMeta | undefined;
    const store = new PrfSeedStore({
      rpId: "localhost",
      persistMeta: (m) => {
        saved = m;
      },
    });
    const [enc, st] = await store.wrapAndSave(enclaveOf(9), {
      salt: DEFAULT_PRF_SALT,
      credId,
      createCredIfNeeded: false,
    });
    expect(st).toBe(Status.Success);
    expect(enc).toBeDefined();
    expect(saved?.credId).toEqual(credId);
    expect(saved?.sealedMaster.byteLength).toBe(72);
    expect(store.meta?.credId).toEqual(credId);
  });

  it("unlock records credId when wrap meta omitted it", async () => {
    const { credId } = stubPrfGet(4);
    const enc = enclaveOf(2);
    const [sealed, sst] = await enc.sealWithPasskey({
      rpId: "localhost",
      salt: DEFAULT_PRF_SALT,
      credId,
    });
    expect(sst).toBe(Status.Success);
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;

    stubPrfGet(4);
    let saved: PrfSeedMeta | undefined;
    const store = new PrfSeedStore({
      rpId: "localhost",
      persistMeta: (m) => {
        saved = m;
      },
      meta: {
        sealedMaster: sealed.sealedMaster,
        salt: sealed.salt,
        // no credId — discoverable unlock should write the breadcrumb
      },
    });
    const [opened, ust] = await store.unlock();
    expect(ust).toBe(Status.Success);
    expect(opened).toBeDefined();
    expect(saved?.credId).toEqual(credId);
    expect(store.meta?.credId).toEqual(credId);
    const orig = await enc.deriveIdentity("test", 0);
    const next = await opened?.deriveIdentity("test", 0);
    expect(next?.publicKey).toEqual(orig.publicKey);
  });
});
