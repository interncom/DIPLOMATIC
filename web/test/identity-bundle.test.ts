import { afterEach, describe, expect, it, vi } from "vitest";
import { Decoder, Encoder } from "../src/shared/codec";
import {
  createIdentityBundle,
  IDENTITY_BUNDLE_VERSION,
  identityBundleCodec,
} from "../src/shared/codecs/identityBundle";
import { Status } from "../src/shared/consts";
import { Enclave, sealKeyFromPrf } from "../src/shared/crypto/enclave";
import {
  asDHKEReq,
  asDHKEResp,
  DHKE_RESP_MIN,
  pairKey,
  PairRequest,
} from "../src/shared/crypto/pairing";
import { NobleCrypto } from "../src/shared/crypto/noble";
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
  const [e, st] = Enclave.fromBytes(seedOf(fill));
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
    // Simulate Enclave zeroing seed after encode (must not corrupt wire).
    bundle.masterSeed.fill(0);
    const dec = new Decoder(enc.result());
    const [out, st] = dec.readStruct(identityBundleCodec);
    expect(st).toBe(Status.Success);
    expect(out).toBeDefined();
    if (out === undefined) return;
    expect(out.v).toBe(IDENTITY_BUNDLE_VERSION);
    expect(out.masterSeed).toEqual(seed);
    expect(out.hosts).toEqual([
      { handle: "https://sync.example.com", label: "host", idx: 0 },
      { handle: "https://b.example.com", label: "backup", idx: 1 },
    ]);
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
    const [opened, ust] = await Enclave.unsealWithPasskey(sealed.sealedMaster,
      {
        rpId: "localhost",
        salt: sealed.salt,
        credId: sealed.credId,
      },
    );
    expect(ust).toBe(Status.Success);
    expect(opened).toBeDefined();
    if (opened === undefined) return;
    expect(opened.credId).toEqual(sealed.credId);
    // Same seed → same derived public key (no seed bytes leave Enclave).
    const a = await enc.deriveIdentity("test", 0);
    const b = await opened.enclave.deriveIdentity("test", 0);
    expect(b.publicKey).toEqual(a.publicKey);
  });

  it("createCredIfNeeded omits platform attachment", async () => {
    const credId = new Uint8Array(16).fill(7);
    const prf = new Uint8Array(32).fill(3);
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { prf: { enabled: true } }),
    );
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
      credentials: { create, get },
    };
    (globalThis as any).PublicKeyCredential = class {};
    (globalThis as any).location = { hostname: "localhost" };

    const [sealed, sst] = await enclaveOf(9).sealWithPasskey({
      rpId: "localhost",
      salt: DEFAULT_PRF_SALT,
      createCredIfNeeded: true,
    });
    expect(sst).toBe(Status.Success);
    expect(sealed?.credId).toEqual(credId);
    expect(create).toHaveBeenCalledOnce();
    const pub = create.mock.calls[0][0].publicKey;
    expect(pub.authenticatorSelection.authenticatorAttachment).toBeUndefined();
    expect(pub.authenticatorSelection.residentKey).toBe("required");
    expect(pub.extensions.prf).toEqual({});
  });

  it("createCredIfNeeded fails closed when create omits prf.enabled", async () => {
    const credId = new Uint8Array(16).fill(7);
    const create = vi.fn().mockResolvedValue(
      mockCred(credId.buffer, { prf: {} }),
    );
    const get = vi.fn();
    (globalThis as any).navigator = {
      credentials: { create, get },
    };
    (globalThis as any).PublicKeyCredential = class {};
    (globalThis as any).location = { hostname: "localhost" };

    const [, sst] = await enclaveOf(9).sealWithPasskey({
      rpId: "localhost",
      salt: DEFAULT_PRF_SALT,
      createCredIfNeeded: true,
    });
    expect(sst).toBe(Status.WebAuthnError);
    expect(get).not.toHaveBeenCalled();
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
    const [, ust] = await Enclave.unsealWithPasskey(sealed.sealedMaster,
      {
        rpId: "localhost",
        salt: sealed.salt,
        credId: sealed.credId,
      },
    );
    expect(ust).toBe(Status.DecryptionError);
  });
});

async function mustReq(): Promise<PairRequest> {
  const [req, st] = await Enclave.pairRequest();
  if (st !== Status.Success || req === undefined) {
    throw new Error(`pairRequest ${st}`);
  }
  return req;
}

describe("DHKE pair (X25519 + blake3 + XSalsa20)", () => {
  it("round-trips seed and hosts", async () => {
    const enc = enclaveOf(8);
    const hosts = [
      { handle: "https://sync.interncom.org", label: "host", idx: 0 },
    ];
    const req = await mustReq();
    expect(req.dhkeReq.byteLength).toBe(32);

    const [dhkeResp, ast] = await enc.pairAccept(req.dhkeReq, hosts);
    expect(ast).toBe(Status.Success);
    expect(dhkeResp).toBeDefined();
    if (dhkeResp === undefined) return;
    expect(dhkeResp.byteLength).toBeGreaterThan(32 + 24 + 16);

    const [opened, ost] = await req.finish(dhkeResp);
    expect(ost).toBe(Status.Success);
    expect(opened).toBeDefined();
    if (opened === undefined) return;
    expect(opened.hosts).toEqual(hosts);
    const origId = await enc.deriveIdentity("test", 0);
    const openId = await opened.enclave.deriveIdentity("test", 0);
    expect(openId.publicKey).toEqual(origId.publicKey);
  });

  it("round-trips empty hosts", async () => {
    const enc = enclaveOf(3);
    const [req, cst] = await PairRequest.create();
    expect(cst).toBe(Status.Success);
    if (req === undefined) return;
    const [dhkeResp, ast] = await enc.pairAccept(req.dhkeReq, []);
    expect(ast).toBe(Status.Success);
    if (dhkeResp === undefined) return;
    const [opened, ost] = await req.finish(dhkeResp);
    expect(ost).toBe(Status.Success);
    expect(opened?.hosts).toEqual([]);
    const a = await enc.deriveIdentity("t", 0);
    const b = await opened?.enclave.deriveIdentity("t", 0);
    expect(b?.publicKey).toEqual(a.publicKey);
  });

  it("rejects the wrong request", async () => {
    const [dhkeResp, ast] = await enclaveOf(1).pairAccept(
      (await mustReq()).dhkeReq,
      [],
    );
    expect(ast).toBe(Status.Success);
    if (dhkeResp === undefined) return;
    const other = await mustReq();
    const [, ost] = await other.finish(dhkeResp);
    expect(ost).toBe(Status.DecryptionError);
  });

  it("rejects truncated dhkeResp", async () => {
    const [, st] = asDHKEResp(new Uint8Array(DHKE_RESP_MIN - 1));
    expect(st).toBe(Status.InvalidParam);
  });

  it("brands a min-length dhkeResp", () => {
    const [q, st] = asDHKEResp(new Uint8Array(DHKE_RESP_MIN));
    expect(st).toBe(Status.Success);
    expect(q?.byteLength).toBe(DHKE_RESP_MIN);
  });

  it("rejects bad enrollee pub length", async () => {
    const [, st] = asDHKEReq(new Uint8Array(16));
    expect(st).toBe(Status.InvalidParam);
  });

  it("dhkeReq getter returns an independent copy", async () => {
    const req = await mustReq();
    const a = req.dhkeReq;
    const b = req.dhkeReq;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.fill(0);
    expect(req.dhkeReq).toEqual(b);
    const [dhkeResp, ast] = await enclaveOf(4).pairAccept(b, []);
    expect(ast).toBe(Status.Success);
    if (dhkeResp === undefined) return;
    const [opened, ost] = await req.finish(dhkeResp);
    expect(ost).toBe(Status.Success);
    expect(opened).toBeDefined();
  });

  it("pairKey agrees and binds both pubs", async () => {
    const n = new NobleCrypto();
    const e = await n.genX25519();
    const r = await n.genX25519();
    const [k1, s1] = await pairKey(e.priv, r.pub, e.pub, r.pub);
    const [k2, s2] = await pairKey(r.priv, e.pub, e.pub, r.pub);
    expect(s1).toBe(Status.Success);
    expect(s2).toBe(Status.Success);
    expect(k1).toEqual(k2);
    const [swapped, sst] = await pairKey(e.priv, r.pub, r.pub, e.pub);
    expect(sst).toBe(Status.Success);
    expect(swapped).toBeDefined();
    expect(k1).not.toEqual(swapped);
  });

  it("tampered resp body fails closed", async () => {
    const req = await mustReq();
    const [dhkeResp, ast] = await enclaveOf(2).pairAccept(req.dhkeReq, []);
    expect(ast).toBe(Status.Success);
    if (dhkeResp === undefined) return;
    const dirty = dhkeResp.slice();
    dirty[dirty.byteLength - 1] ^= 1;
    const [branded, bst] = asDHKEResp(dirty);
    expect(bst).toBe(Status.Success);
    if (branded === undefined) return;
    const [, ost] = await req.finish(branded);
    expect(ost).toBe(Status.DecryptionError);
  });

  it("second finish fails after wipe", async () => {
    const req = await mustReq();
    const [dhkeResp, ast] = await enclaveOf(6).pairAccept(req.dhkeReq, []);
    expect(ast).toBe(Status.Success);
    if (dhkeResp === undefined) return;
    const [opened, ost] = await req.finish(dhkeResp);
    expect(ost).toBe(Status.Success);
    expect(opened).toBeDefined();
    const [, ost2] = await req.finish(dhkeResp);
    expect(ost2).toBe(Status.DecryptionError);
  });
});

describe("sealKeyFromPrf domains", () => {
  it("wrap KEK is domain-separated from a different domain", async () => {
    const prf = new Uint8Array(32).fill(3);
    const other = new TextEncoder().encode("diplomatic.other.v1");
    const [wrapKey, wst] = await sealKeyFromPrf(crypto, prf);
    const [otherKey, ost] = await sealKeyFromPrf(crypto, prf, other);
    expect(wst).toBe(Status.Success);
    expect(ost).toBe(Status.Success);
    expect(wrapKey).toBeDefined();
    expect(otherKey).toBeDefined();
    if (wrapKey === undefined || otherKey === undefined) return;
    expect(wrapKey).not.toEqual(otherKey);
  });
});
