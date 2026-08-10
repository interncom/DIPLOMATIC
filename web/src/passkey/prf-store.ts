// Seed store: durable sealed master in memory + app-owned meta persistence; unlock via PRF.

import { Enclave } from "../shared/crypto/enclave";
import { Status } from "../shared/consts";
import {
  asSealedMasterKey,
  type MasterSeed,
  type SealedMasterKey,
} from "../shared/seed";
import type { ICrypto } from "../shared/types";
import { err, ok, type ValStat } from "../shared/valstat";
import type { ISeedStore, SetSeedOpts } from "../types";
import { DEFAULT_PRF_SALT, evalPrf, type PrfRp } from "./prf";
import { sealMaster, unsealMaster } from "./secret-split";

export type PrfSeedMeta = {
  /** AEAD-sealed master under KDF(PRF). */
  sealedMaster: SealedMasterKey;
  /** PRF salt used at wrap time. */
  salt: Uint8Array;
  /** Optional allowCredentials id. */
  credId?: Uint8Array;
};

/**
 * Persist sealed-master metadata for cold start (e.g. write/clear IDB).
 * Called with `undefined` when the store is wiped.
 */
export type PersistPrfSeedMeta = (
  meta: PrfSeedMeta | undefined,
) => void | Promise<void>;

export type PrfSeedStoreOpts = PrfRp & {
  /** Crypto backend for wrap/unwrap and enclave (noble, libsodium, …). */
  crypto: ICrypto;
  /**
   * Required durable write path for sealed master + salt + credId.
   * App typically stores this in IndexedDB; cold start reloads via `meta`.
   */
  persistMeta: PersistPrfSeedMeta;
  /** Previously persisted meta (cold start). Does not re-call persistMeta. */
  meta?: PrfSeedMeta;
};

/**
 * Session + durable PRF-wrapped seed.
 *
 * Persistence is split by design:
 * - **In-memory**: enclave after save / unlock.
 * - **Durable sealed blob**: {@link wrapAndSave} / unlock / wipe → {@link PersistPrfSeedMeta}.
 * - **PRF key material**: WebAuthn only (not stored by this class).
 *
 * - {@link save} is memory-only; use {@link wrapAndSave} to seal under PRF.
 * - {@link load} returns the in-memory enclave only.
 * - {@link unlock} runs the PRF ceremony and unwraps {@link PrfSeedMeta.sealedMaster}.
 */
export class PrfSeedStore implements ISeedStore {
  #crypto: ICrypto;
  #enclave: Enclave | undefined;
  #meta: PrfSeedMeta | undefined;
  #rp: PrfRp;
  #persistMeta: PersistPrfSeedMeta;

  constructor(opts: PrfSeedStoreOpts) {
    this.#crypto = opts.crypto;
    this.#persistMeta = opts.persistMeta;
    this.#rp = { rpId: opts.rpId, rpName: opts.rpName };
    if (opts.meta !== undefined) {
      this.#meta = cloneMeta(opts.meta);
    }
  }

  get meta(): PrfSeedMeta | undefined {
    return this.#meta === undefined ? undefined : cloneMeta(this.#meta);
  }

  /**
   * Replace in-memory meta without writing durable storage
   * (e.g. after loading from IDB outside the constructor).
   */
  setMeta(meta: PrfSeedMeta | undefined): void {
    this.#meta = meta === undefined ? undefined : cloneMeta(meta);
  }

  async save(seed: MasterSeed, opts?: SetSeedOpts): Promise<Enclave> {
    // Memory-only by default; durable wrap requires wrapAndSave(prf).
    if (opts?.persist === true) {
      return Promise.reject(
        new Error(
          "prf-store: use wrapAndSave(seed, prf) to persist sealed master",
        ),
      );
    }
    this.#enclave = new Enclave(seed, this.#crypto);
    return this.#enclave;
  }

  /**
   * Wrap master under PRF, update meta, and persist via {@link PersistPrfSeedMeta}.
   */
  async wrapAndSave(
    seed: MasterSeed,
    prf: Uint8Array,
    opts?: { salt?: Uint8Array; credId?: Uint8Array },
  ): Promise<ValStat<Enclave>> {
    const salt = opts?.salt ?? DEFAULT_PRF_SALT;
    const [sealedMaster, wst] = await sealMaster(this.#crypto, seed, prf);
    if (wst !== Status.Success || sealedMaster === undefined) return err(wst);
    const meta: PrfSeedMeta = {
      sealedMaster,
      salt: salt.slice(),
      credId: opts?.credId?.slice(),
    };
    this.#meta = meta;
    this.#enclave = new Enclave(seed, this.#crypto);
    await this.#persistMeta(cloneMeta(meta));
    return ok(this.#enclave);
  }

  async load(): Promise<Enclave | void> {
    return this.#enclave;
  }

  /** Passkey UV → PRF → unwrap sealed master from meta. */
  async unlock(): Promise<ValStat<Enclave>> {
    const meta = this.#meta;
    if (meta === undefined) return err(Status.MissingSeed);
    const [ev, est] = await evalPrf({
      rpId: this.#rp.rpId,
      rpName: this.#rp.rpName,
      credId: meta.credId,
      salt: meta.salt,
    });
    if (est !== Status.Success || ev === undefined) return err(est);
    // Refresh cred id if discoverable returned one.
    if (meta.credId === undefined) {
      meta.credId = ev.credId;
      this.#meta = cloneMeta(meta);
      await this.#persistMeta(cloneMeta(meta));
    }
    const [seed, ust] = await unsealMaster(
      this.#crypto,
      meta.sealedMaster,
      ev.prf,
    );
    if (ust !== Status.Success || seed === undefined) return err(ust);
    this.#enclave = new Enclave(seed, this.#crypto);
    return ok(this.#enclave);
  }

  async wipe(): Promise<void> {
    this.#enclave = undefined;
    this.#meta = undefined;
    await this.#persistMeta(undefined);
  }
}

function cloneMeta(m: PrfSeedMeta): PrfSeedMeta {
  const [sealedMaster, st] = asSealedMasterKey(m.sealedMaster.slice());
  return {
    sealedMaster:
      st === Status.Success && sealedMaster !== undefined
        ? sealedMaster
        : m.sealedMaster,
    salt: m.salt.slice(),
    credId: m.credId === undefined ? undefined : m.credId.slice(),
  };
}
