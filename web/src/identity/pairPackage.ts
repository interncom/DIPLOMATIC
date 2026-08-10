// Pair package: AEAD(plain) under KDF(PRF) for device pairing.
// String form (`dip1:` + base64url) can be typed, pasted, or shown as a QR code.

import { b64urltob, btob64url } from "../shared/binary";
import { Decoder, Encoder } from "../shared/codec";
import {
  type PairPackagePlain,
  pairPackagePlainCodec,
} from "../shared/codecs/pairPackage";
import {
  PAIR_PACKAGE_VERSION,
  pairPackageEnvelopeCodec,
} from "../shared/codecs/pairPackageEnvelope";
import { Status } from "../shared/consts";
import type { ICrypto } from "../shared/types";
import {
  asMasterSeed,
  type MasterSeed,
  type SealedMasterKey,
} from "../shared/seed";
import { err, ok, type ValStat } from "../shared/valstat";
import { DEFAULT_PRF_SALT } from "../passkey/prf";
import { sealKeyFromPrf, sealMaster } from "../passkey/secret-split";
import type { BundleHost } from "../shared/codecs/bundleHost";

export {
  type PairPackagePlain,
  pairPackagePlainCodec,
} from "../shared/codecs/pairPackage";
export {
  PAIR_PACKAGE_VERSION,
  type PairPackageEnvelope,
  pairPackageEnvelopeCodec,
} from "../shared/codecs/pairPackageEnvelope";

export type OpenedPairPackage = {
  masterSeed: MasterSeed;
  hosts: BundleHost[];
  salt: Uint8Array;
  credId?: Uint8Array;
  /** Sealed master for IDB, under same sealKey. */
  sealedMaster: SealedMasterKey;
};

/**
 * Pair package seal/open under PRF.
 *
 * @example
 * ```ts
 * const [pairPkg, st] = await PairPackage.seal(crypto, seed, hosts, prf);
 * const [opened, ost] = await PairPackage.open(crypto, pairPkg, prf);
 * ```
 */
export const PairPackage = {
  /** Prefix for the string form (typed, pasted, or QR payload). */
  PREFIX: "dip1:" as const,

  VERSION: PAIR_PACKAGE_VERSION,

  /**
   * Seal seed + hosts under PRF → `dip1:` + base64url(envelope).
   * Caller must already have `prf` from a ceremony (same passkey as new device).
   * A pairing QR is just a QR code of this string.
   */
  async seal(
    crypto: ICrypto,
    masterSeed: MasterSeed,
    hosts: BundleHost[],
    prf: Uint8Array,
    opts?: { salt?: Uint8Array; credId?: Uint8Array },
  ): Promise<ValStat<string>> {
    const [seedIn, seedSt] = asMasterSeed(masterSeed);
    if (seedSt !== Status.Success || seedIn === undefined) return err(seedSt);
    const [seedCopy, copySt] = asMasterSeed(seedIn.slice());
    if (copySt !== Status.Success || seedCopy === undefined) return err(copySt);
    const salt = opts?.salt ?? DEFAULT_PRF_SALT;
    const [sealKey, kst] = await sealKeyFromPrf(crypto, prf);
    if (kst !== Status.Success || sealKey === undefined) return err(kst);

    const plain: PairPackagePlain = {
      masterSeed: seedCopy,
      hosts: hosts.map((h) => ({
        handle: h.handle,
        label: h.label,
        idx: h.idx,
      })),
    };
    const plainEnc = new Encoder();
    const pst = plainEnc.writeStruct(pairPackagePlainCodec, plain);
    if (pst !== Status.Success) return err(pst);

    let body: Uint8Array;
    try {
      body = await crypto.encryptXSalsa20Poly1305Combined(
        plainEnc.result(),
        sealKey,
      );
    } catch {
      return err(Status.InternalError);
    }

    const envEnc = new Encoder();
    const est = envEnc.writeStruct(pairPackageEnvelopeCodec, {
      v: PAIR_PACKAGE_VERSION,
      salt: salt.slice(),
      credId: opts?.credId?.slice() ?? new Uint8Array(0),
      body,
    });
    if (est !== Status.Success) return err(est);
    return ok(PairPackage.PREFIX + btob64url(envEnc.result()));
  },

  /**
   * Open a string pair package after PRF ceremony on the new device.
   * Accepts typed/pasted text or the payload decoded from a QR scan.
   */
  async open(
    crypto: ICrypto,
    pairPkg: string,
    prf: Uint8Array,
  ): Promise<ValStat<OpenedPairPackage>> {
    const trimmed = pairPkg.trim();
    if (!trimmed.startsWith(PairPackage.PREFIX)) {
      return err(Status.InvalidParam);
    }

    let envelopeBytes: Uint8Array;
    try {
      envelopeBytes = b64urltob(trimmed.slice(PairPackage.PREFIX.length));
    } catch {
      return err(Status.InvalidParam);
    }
    const dec = new Decoder(envelopeBytes);
    const [env, es] = dec.readStruct(pairPackageEnvelopeCodec);
    if (es !== Status.Success || env === undefined) return err(es);
    if (env.v !== PAIR_PACKAGE_VERSION) return err(Status.InvalidMessage);

    const [sealKey, kst] = await sealKeyFromPrf(crypto, prf);
    if (kst !== Status.Success || sealKey === undefined) return err(kst);

    let plain: Uint8Array;
    try {
      plain = await crypto.decryptXSalsa20Poly1305Combined(env.body, sealKey);
    } catch {
      return err(Status.DecryptionError);
    }

    const pdec = new Decoder(plain);
    const [inner, is] = pdec.readStruct(pairPackagePlainCodec);
    if (is !== Status.Success || inner === undefined) return err(is);
    const [masterSeed, mst] = asMasterSeed(inner.masterSeed);
    if (mst !== Status.Success || masterSeed === undefined) return err(mst);

    // Same wrap key as the package body — re-seal for local PRF IDB storage.
    const [sealedMaster, sealSt] = await sealMaster(crypto, masterSeed, prf);
    if (sealSt !== Status.Success || sealedMaster === undefined) {
      return err(sealSt);
    }

    return ok({
      masterSeed,
      hosts: inner.hosts.map((h) => ({ ...h })),
      salt: env.salt.slice(),
      credId: env.credId.byteLength > 0 ? env.credId.slice() : undefined,
      sealedMaster,
    });
  },
} as const;
