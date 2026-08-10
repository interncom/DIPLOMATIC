import { describe, expect, it } from "vitest";
import { Decoder, Encoder } from "../src/shared/codec";
import {
  createIdentityBundle,
  IDENTITY_BUNDLE_VERSION,
  identityBundleCodec,
} from "../src/shared/codecs/identityBundle";
import { Status } from "../src/shared/consts";
import { PairPackage } from "../src/identity/pairPackage";
import { sealMaster, unsealMaster } from "../src/passkey/secret-split";
import crypto from "../src/crypto";
import type { MasterSeed } from "../src/shared/seed";

function seedOf(fill: number): MasterSeed {
  return new Uint8Array(32).fill(fill) as MasterSeed;
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
      hosts: [] });
    expect(st).toBe(Status.InvalidParam);
  });
});

describe("secret-split seal/unseal", () => {
  it("round-trips master under PRF", async () => {
    const seed = seedOf(9);
    const prf = seedOf(3);
    const [sealed, sst] = await sealMaster(crypto, seed, prf);
    expect(sst).toBe(Status.Success);
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;
    expect(sealed.byteLength).toBe(72);
    const [opened, ust] = await unsealMaster(crypto, sealed, prf);
    expect(ust).toBe(Status.Success);
    expect(opened).toEqual(seed);
  });

  it("fails closed on wrong PRF", async () => {
    const [sealed, sst] = await sealMaster(crypto, seedOf(1), seedOf(2));
    expect(sst).toBe(Status.Success);
    expect(sealed).toBeDefined();
    if (sealed === undefined) return;
    const [, ust] = await unsealMaster(crypto, sealed, seedOf(3));
    expect(ust).toBe(Status.DecryptionError);
  });
});

describe("PairPackage", () => {
  it("round-trips under PRF", async () => {
    const seed = seedOf(8);
    const prf = seedOf(6);
    const hosts = [
      { handle: "https://sync.interncom.org", label: "host", idx: 0 },
    ];
    const [pairPkg, pst] = await PairPackage.seal(crypto, seed, hosts, prf);
    expect(pst).toBe(Status.Success);
    expect(pairPkg).toBeDefined();
    if (pairPkg === undefined) return;
    expect(pairPkg.startsWith(PairPackage.PREFIX)).toBe(true);
    const [opened, ost] = await PairPackage.open(crypto, pairPkg, prf);
    expect(ost).toBe(Status.Success);
    expect(opened).toBeDefined();
    if (opened === undefined) return;
    expect(opened.masterSeed).toEqual(seed);
    expect(opened.hosts).toEqual(hosts);
    const [again, ust] = await unsealMaster(
      crypto,
      opened.sealedMaster,
      prf,
    );
    expect(ust).toBe(Status.Success);
    expect(again).toEqual(seed);
  });

  it("fails with wrong PRF", async () => {
    const [pairPkg, pst] = await PairPackage.seal(
      crypto,
      seedOf(1),
      [],
      seedOf(2),
    );
    expect(pst).toBe(Status.Success);
    expect(pairPkg).toBeDefined();
    if (pairPkg === undefined) return;
    const [, ost] = await PairPackage.open(crypto, pairPkg, seedOf(9));
    expect(ost).toBe(Status.DecryptionError);
  });
});
