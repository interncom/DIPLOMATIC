import { afterEach, describe, expect, it, vi } from "vitest";
import { Decoder, Encoder } from "../src/shared/codec";
import {
  createIdentityBundle,
  IDENTITY_BUNDLE_VERSION,
  identityBundleCodec,
} from "../src/shared/codecs/identityBundle";
import { Status } from "../src/shared/consts";
import { Enclave } from "../src/shared/crypto/enclave";
import { PairPackage } from "../src/identity/pairPackage";
import crypto from "../src/crypto";
import { asMasterSeed, type MasterSeed } from "../src/shared/seed";
import { DEFAULT_PRF_SALT } from "../src/shared/webauthn/prf";

function seedOf(fill: number): MasterSeed {
  const [seed, st] = asMasterSeed(new Uint8Array(32).fill(fill));
  if (st !== Status.Success || seed === undefined) {
    throw new Error(`seedOf ${st}`);
  }
  return seed;
}

function enclaveOf(fill: number): Enclave {
  const [e, st] = Enclave.fromBytes(crypto, seedOf(fill));
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

/** Stub WebAuthn get to return a fixed PRF (works under bun test without vi.stubGlobal). */
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
  (globalThis as any).navigator = {
    credentials: { create: vi.fn(), get },
  };
  (globalThis as any).PublicKeyCredential = class {};
  (globalThis as any).location = { hostname: "localhost" };
  return { get, credId, prf };
}

describe("IdentityBundle codec", () => {
  it("round-trips seed and hosts", () => {
    const seed = seedOf(7);
    const [bundle, cst] = createIdentityBundle(seed, [
      { handle: "https://sync.example.com", label: "host", idx: 0 },
      { handle: "https://b.example.com", label: "backup", idx: 1 },
    ]);
    expect(cst).toBe(Status.Success);
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;
    const enc = new Encoder();
    expect(enc.writeStruct(identityBundleCodec, bundle)).toBe(Status.Success);
    const dec = new Decoder(enc.result());
    const [out, st] = dec.readStruct(identityBundleCodec);
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    if (out === undefined) return;
    expect(out.v).toBe(IDENTITY_BUNDLE_VERSION);
    expect(out.masterSeed).toEqual(seed);
    expect(out.hosts).toEqual(bundle.hosts);
  });

  it("round-trips empty hosts", () => {
    const seed = seedOf(1);
    const [bundle, cst] = createIdentityBundle(seed, []);
    expect(cst).toBe(Status.Success);
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;
    const enc = new Encoder();
    expect(enc.writeStruct(identityBundleCodec, bundle)).toBe(Status.Success);
    const [out, st] = new Decoder(enc.result()).readStruct(identityBundleCodec);
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    if (out === undefined) return;
    expect(out.hosts).toEqual([]);
    expect(out.masterSeed).toEqual(seed);
  });

  it("rejects bad seed length on create", () => {
    const [, st] = createIdentityBundle(new Uint8Array(16) as MasterSeed, []);
    expect(st).toBe(Status.InvalidParam);
  });

  it("rejects bad seed length on encode", () => {
    const enc = new Encoder();
    const st = enc.writeStruct(identityBundleCodec, {
      v: IDENTITY_BUNDLE_VERSION,
      masterSeed: new Uint8Array(16) as MasterSeed,
      hosts: [],
    });
    expect(st).toBe(Status.InvalidParam);
  });
});

describe("enclave seal/unseal via passkey PRF ceremony", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips master under PRF ceremony", async () => {
    stubPrfGet(3);
    const enc = enclaveOf(9);
    const [sealed, sst] = await enc.sealWithPasskey({
      rpId: "localhost",
      salt: DEFAULT_PRF_SALT,
      createCredIfNeeded: false,
      credId: new Uint8Array(16).fill(7),
    });
    expect(sst).toBe(Status.Success);
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;
    expect(sealed.sealedMaster.byteLength).toBe(72);

    stubPrfGet(3);
    const [opened, ust] = await Enclave.unsealWithPasskey(
      crypto,
      sealed.sealedMaster,
      {
        rpId: "localhost",
        salt: sealed.salt,
        credId: sealed.credId,
      },
    );
    expect(ust).toBe(Status.Success);
    expect(opened).toBeDefined();
    if (opened === undefined) return;
    // Same seed → same derived public key (no seed bytes leave Enclave).
    const a = await enc.deriveIdentity("test", 0);
    const b = await opened.deriveIdentity("test", 0);
    expect(b.publicKey).toEqual(a.publicKey);
  });

  it("fails closed on wrong PRF", async () => {
    stubPrfGet(2);
    const [sealed, sst] = await enclaveOf(1).sealWithPasskey({
      rpId: "localhost",
      salt: DEFAULT_PRF_SALT,
      credId: new Uint8Array(16).fill(7),
    });
    expect(sst).toBe(Status.Success);
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;

    stubPrfGet(3); // different PRF
    const [, ust] = await Enclave.unsealWithPasskey(
      crypto,
      sealed.sealedMaster,
      {
        rpId: "localhost",
        salt: sealed.salt,
        credId: sealed.credId,
      },
    );
    expect(ust).toBe(Status.DecryptionError);
  });
});

describe("PairPackage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips under PRF ceremony", async () => {
    stubPrfGet(6);
    const enc = enclaveOf(8);
    const hosts = [
      { handle: "https://sync.interncom.org", label: "host", idx: 0 },
    ];
    const [pairPkg, pst] = await PairPackage.seal(crypto, enc, hosts, {
      rpId: "localhost",
      salt: DEFAULT_PRF_SALT,
      credId: new Uint8Array(16).fill(7),
    });
    expect(pst).toBe(Status.Success);
    expect(pairPkg).toBeDefined();
    if (pairPkg === undefined) return;
    expect(pairPkg.startsWith(PairPackage.PREFIX)).toBe(true);

    stubPrfGet(6);
    const [opened, ost] = await PairPackage.open(crypto, pairPkg, {
      rpId: "localhost",
    });
    expect(ost).toBe(Status.Success);
    expect(opened).toBeDefined();
    if (opened === undefined) return;
    expect(opened.hosts).toEqual(hosts);
    const origId = await enc.deriveIdentity("test", 0);
    const openId = await opened.enclave.deriveIdentity("test", 0);
    expect(openId.publicKey).toEqual(origId.publicKey);

    stubPrfGet(6);
    const [again, ust] = await Enclave.unsealWithPasskey(
      crypto,
      opened.sealedMaster,
      {
        rpId: "localhost",
        salt: opened.salt,
        credId: opened.credId,
      },
    );
    expect(ust).toBe(Status.Success);
    expect(again).toBeDefined();
    if (again === undefined) return;
    const againId = await again.deriveIdentity("test", 0);
    expect(againId.publicKey).toEqual(origId.publicKey);
  });

  it("fails with wrong PRF", async () => {
    stubPrfGet(2);
    const [pairPkg, pst] = await PairPackage.seal(
      crypto,
      enclaveOf(1),
      [],
      {
        rpId: "localhost",
        salt: DEFAULT_PRF_SALT,
        credId: new Uint8Array(16).fill(7),
      },
    );
    expect(pst).toBe(Status.Success);
    expect(pairPkg).toBeDefined();
    if (pairPkg === undefined) return;

    stubPrfGet(9);
    const [, ost] = await PairPackage.open(crypto, pairPkg, {
      rpId: "localhost",
    });
    expect(ost).toBe(Status.DecryptionError);
  });
});
