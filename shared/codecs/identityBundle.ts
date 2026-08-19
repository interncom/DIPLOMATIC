// Full identity backup: master seed + host connection rows.
// Untagged DIPLOMATIC codec; YubiKey largeBlob stores the encoded bytes raw.

import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { asMasterSeed, MASTER_SEED_LEN, type MasterSeed } from "../seed.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { type BundleHost, bundleHostCodec } from "./bundleHost.ts";

export { type BundleHost, bundleHostCodec } from "./bundleHost.ts";

export const IDENTITY_BUNDLE_VERSION = 1;

export type IdentityBundle = {
  v: number;
  masterSeed: MasterSeed;
  hosts: BundleHost[];
};

/**
 * IdentityBundle wire layout:
 *   v: varint
 *   masterSeed: 32 fixed bytes
 *   hostsLen: varint
 *   hosts: hostsLen × BundleHost
 */
export const identityBundleCodec: ICodecStruct<IdentityBundle> = {
  encode(enc, b) {
    if (b.v !== IDENTITY_BUNDLE_VERSION) return Status.InvalidParam;
    const [, seedSt] = asMasterSeed(b.masterSeed);
    if (seedSt !== Status.Success) return seedSt;
    const s0 = enc.writeVarInt(b.v);
    if (s0 !== Status.Success) return s0;
    enc.writeBytes(b.masterSeed);
    const s1 = enc.writeVarInt(b.hosts.length);
    if (s1 !== Status.Success) return s1;
    for (const h of b.hosts) {
      const s2 = enc.writeStruct(bundleHostCodec, h);
      if (s2 !== Status.Success) return s2;
    }
    return Status.Success;
  },
  decode(dec) {
    const [v, s0] = dec.readVarInt();
    if (s0 !== Status.Success) return err(s0);
    if (v !== IDENTITY_BUNDLE_VERSION) return err(Status.InvalidMessage);
    const [raw, s1] = dec.readBytes(MASTER_SEED_LEN);
    if (s1 !== Status.Success) return err(s1);
    if (raw === undefined) return err(Status.InvalidMessage);
    const [masterSeed, seedSt] = asMasterSeed(raw);
    if (seedSt !== Status.Success) return err(seedSt);
    if (masterSeed === undefined) return err(Status.InvalidMessage);
    const [n, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    if (n === undefined || n < 0) return err(Status.InvalidParam);
    const hosts: BundleHost[] = [];
    for (let i = 0; i < n; i++) {
      const [h, s3] = dec.readStruct(bundleHostCodec);
      if (s3 !== Status.Success) return err(s3);
      if (h === undefined) return err(Status.InvalidMessage);
      hosts.push(h);
    }
    return ok({
      v: IDENTITY_BUNDLE_VERSION,
      masterSeed,
      hosts,
    });
  },
};

/**
 * Build a wire-format identity bundle from a branded {@link MasterSeed} + hosts.
 * Codec/tests only. Runtime persist uses a file-local copy in enclave.ts.
 */
export function createIdentityBundle(
  masterSeed: MasterSeed,
  hosts: BundleHost[],
): ValStat<IdentityBundle> {
  const [seed, seedSt] = asMasterSeed(masterSeed);
  if (seedSt !== Status.Success) return err(seedSt);
  if (seed === undefined) return err(Status.InvalidParam);
  const [copy, copySt] = asMasterSeed(seed.slice());
  if (copySt !== Status.Success) return err(copySt);
  if (copy === undefined) return err(Status.InvalidParam);
  return ok({
    v: IDENTITY_BUNDLE_VERSION,
    masterSeed: copy,
    hosts: hosts.map((h) => ({
      handle: h.handle,
      label: h.label,
      idx: h.idx ?? 0,
    })),
  });
}
