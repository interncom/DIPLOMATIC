// Pair package: AEAD(plain) under KDF(PRF) for device pairing.
// String form (`dip1:` + base64url) can be typed, pasted, or shown as a QR code.
// PRF ceremony + seed AEAD live entirely inside Enclave; this layer is envelope only.

import { b64urltob, btob64url } from "../shared/binary";
import { Decoder, Encoder } from "../shared/codec";
import {
  PAIR_PACKAGE_VERSION,
  pairPackageEnvelopeCodec,
} from "../shared/codecs/pairPackageEnvelope";
import { Status } from "../shared/consts";
import { Enclave, type PasskeyPrfOpts } from "../shared/crypto/enclave";
import type { SealedMasterKey } from "../shared/seed";
import type { ICrypto } from "../shared/types";
import { err, ok, type ValStat } from "../shared/valstat";
import type { BundleHost } from "../shared/codecs/bundleHost";
import type { PrfRp } from "../shared/webauthn/prf";

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
  enclave: Enclave;
  hosts: BundleHost[];
  salt: Uint8Array;
  credId?: Uint8Array;
  /** Sealed master for protocol IDB, under same PRF (single ceremony). */
  sealedMaster: SealedMasterKey;
};

/**
 * Pair package seal/open under PRF.
 */
export const PairPackage = {
  PREFIX: "dip1:" as const,
  VERSION: PAIR_PACKAGE_VERSION,

  /**
   * Seal enclave seed + hosts: Enclave runs PRF UV, then AEAD → `dip1:` string.
   */
  async seal(
    _crypto: ICrypto,
    enclave: Enclave,
    hosts: BundleHost[],
    opts?: PasskeyPrfOpts,
  ): Promise<ValStat<string>> {
    const [out, bst] = await enclave.sealPairPackageBody(hosts, opts);
    if (bst !== Status.Success) return err(bst);
    if (out === undefined) return err(Status.InternalError);

    const envEnc = new Encoder();
    const est = envEnc.writeStruct(pairPackageEnvelopeCodec, {
      v: PAIR_PACKAGE_VERSION,
      salt: out.salt,
      credId: out.credId,
      body: out.body,
    });
    if (est !== Status.Success) return err(est);
    return ok(PairPackage.PREFIX + btob64url(envEnc.result()));
  },

  /**
   * Open pair package: decode envelope, Enclave runs PRF UV + decrypt + enclave.
   */
  async open(
    crypto: ICrypto,
    pairPkg: string,
    rp: PrfRp,
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
    if (es !== Status.Success) return err(es);
    if (env === undefined) return err(Status.InvalidMessage);
    if (env.v !== PAIR_PACKAGE_VERSION) return err(Status.InvalidMessage);

    const [opened, ost] = await Enclave.openPairPackageBody(crypto, env.body, {
      ...rp,
      salt: env.salt,
      credId: env.credId.byteLength > 0 ? env.credId : undefined,
    });
    if (ost !== Status.Success) return err(ost);
    if (opened === undefined) return err(Status.InternalError);

    return ok({
      enclave: opened.enclave,
      hosts: opened.hosts,
      salt: env.salt.slice(),
      credId: opened.credId,
      sealedMaster: opened.sealedMaster,
    });
  },
} as const;
