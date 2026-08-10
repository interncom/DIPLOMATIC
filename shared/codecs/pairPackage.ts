// Pair package inner body: master seed + host rows (plaintext before AEAD).

import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { asMasterSeed, MASTER_SEED_LEN, type MasterSeed } from "../seed.ts";
import { err, ok } from "../valstat.ts";
import { type BundleHost, bundleHostCodec } from "./bundleHost.ts";

export type PairPackagePlain = {
  masterSeed: MasterSeed;
  hosts: BundleHost[];
};

/**
 * Inner plaintext body (not sealed here — AEAD is applied by the pairing
 * ceremony, then carried as `body` in {@link pairPackageEnvelopeCodec}):
 *   masterSeed: 32 fixed bytes
 *   hostsLen: varint
 *   hosts: hostsLen × BundleHost
 */
export const pairPackagePlainCodec: ICodecStruct<PairPackagePlain> = {
  encode(enc, p) {
    const [, seedSt] = asMasterSeed(p.masterSeed);
    if (seedSt !== Status.Success) return seedSt;
    enc.writeBytes(p.masterSeed);
    const s0 = enc.writeVarInt(p.hosts.length);
    if (s0 !== Status.Success) return s0;
    for (const h of p.hosts) {
      const s1 = enc.writeStruct(bundleHostCodec, h);
      if (s1 !== Status.Success) return s1;
    }
    return Status.Success;
  },
  decode(dec) {
    const [raw, s0] = dec.readBytes(MASTER_SEED_LEN);
    if (s0 !== Status.Success) return err(s0);
    if (raw === undefined) return err(Status.InvalidMessage);
    const [masterSeed, seedSt] = asMasterSeed(raw);
    if (seedSt !== Status.Success || masterSeed === undefined) {
      return err(seedSt);
    }
    const [n, s1] = dec.readVarInt();
    if (s1 !== Status.Success) return err(s1);
    if (n === undefined || n < 0) return err(Status.InvalidParam);
    const hosts: BundleHost[] = [];
    for (let i = 0; i < n; i++) {
      const [h, s2] = dec.readStruct(bundleHostCodec);
      if (s2 !== Status.Success) return err(s2);
      if (h === undefined) return err(Status.InvalidMessage);
      hosts.push(h);
    }
    return ok({ masterSeed, hosts });
  },
};
