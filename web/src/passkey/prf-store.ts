// Seed store: durable sealed master in protocol IDB + unlock via PRF ceremony.
// Session handle is always an Enclave. PRF bytes never leave Enclave methods.

import { Enclave } from "../shared/crypto/enclave";
import { Status } from "../shared/consts";
import { asSealedMasterKey, type SealedMasterKey } from "../shared/seed";
import type { ICrypto } from "../shared/types";
import { err, ok, type ValStat } from "../shared/valstat";
import type { ISeedStore, SetSeedOpts } from "../types";
import type { PrfRp } from "../shared/webauthn/prf";

export type PrfSeedMeta = {
  /** AEAD-sealed master under KDF(PRF). */
  sealedMaster: SealedMasterKey;
  /** PRF salt used at wrap time. */
  salt: Uint8Array;
  /** Optional allowCredentials id. */
  credId?: Uint8Array;
};

/**
 * Persist sealed-master metadata for cold start (e.g. protocol IDB seedMeta).
 * Called with `undefined` when the store is wiped.
 */
export type PersistPrfSeedMeta = (
  meta: PrfSeedMeta | undefined,
) => void | Promise<void>;

export type PrfSeedStoreOpts = PrfRp & {
  crypto: ICrypto;
  /**
   * Required durable write path for sealed master + salt + credId.
   * Protocol IDB implements this via {@link IDBSeedStore.persistPrfMeta}.
   */
  persistMeta: PersistPrfSeedMeta;
  /** Previously persisted meta (cold start). Does not re-call persistMeta. */
  meta?: PrfSeedMeta;
};

/**
 * Session + durable PRF-wrapped seed. Session secret is always {@link Enclave}.
 *
 * - {@link save} is memory-only (holds enclave).
 * - {@link wrapAndSave} runs PRF UV inside Enclave and persists sealed meta.
 * - {@link unlock} runs PRF UV inside Enclave and returns a new enclave.
 *
 * Fallback when PRF is unavailable (not implemented yet): passphrase-sealed
 * meta with the same layout — no plain seed on disk either way.
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

  setMeta(meta: PrfSeedMeta | undefined): void {
    this.#meta = meta === undefined ? undefined : cloneMeta(meta);
  }

  async save(enclave: Enclave, opts?: SetSeedOpts): Promise<Enclave> {
    if (opts?.persist === true) {
      return Promise.reject(
        new Error(
          "prf-store: use wrapAndSave(enclave) to persist sealed master",
        ),
      );
    }
    this.#enclave = enclave;
    return this.#enclave;
  }

  /**
   * PRF UV inside Enclave, seal master, persist meta (no PRF leaves Enclave).
   */
  async wrapAndSave(
    enclave: Enclave,
    opts?: {
      salt?: Uint8Array;
      credId?: Uint8Array;
      createCredIfNeeded?: boolean;
    },
  ): Promise<ValStat<Enclave>> {
    const [sealed, sst] = await enclave.sealWithPasskey({
      ...this.#rp,
      salt: opts?.salt,
      credId: opts?.credId ?? this.#meta?.credId,
      createCredIfNeeded: opts?.createCredIfNeeded ??
        opts?.credId === undefined,
      userName: "diplomatic-prf",
    });
    if (sst !== Status.Success) return err(sst);
    if (sealed === undefined) return err(Status.InternalError);

    const meta: PrfSeedMeta = {
      sealedMaster: sealed.sealedMaster,
      salt: sealed.salt,
      credId: sealed.credId,
    };
    this.#meta = meta;
    this.#enclave = enclave;
    await this.#persistMeta(cloneMeta(meta));
    return ok(this.#enclave);
  }

  async load(): Promise<Enclave | void> {
    return this.#enclave;
  }

  /** Passkey UV inside Enclave → new session enclave. */
  async unlock(): Promise<ValStat<Enclave>> {
    const meta = this.#meta;
    if (meta === undefined) return err(Status.MissingSeed);
    const [enclave, ust] = await Enclave.unsealWithPasskey(
      this.#crypto,
      meta.sealedMaster,
      {
        ...this.#rp,
        salt: meta.salt,
        credId: meta.credId,
      },
    );
    if (ust !== Status.Success) return err(ust);
    if (enclave === undefined) return err(Status.InternalError);
    this.#enclave = enclave;
    return ok(enclave);
  }

  /**
   * Install sealed meta + session enclave (e.g. after pair-package open) and persist.
   */
  async adoptSealed(
    enclave: Enclave,
    meta: PrfSeedMeta,
  ): Promise<ValStat<Enclave>> {
    this.#meta = cloneMeta(meta);
    this.#enclave = enclave;
    await this.#persistMeta(cloneMeta(meta));
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
    sealedMaster: st === Status.Success && sealedMaster !== undefined
      ? sealedMaster
      : m.sealedMaster,
    salt: m.salt.slice(),
    credId: m.credId === undefined ? undefined : m.credId.slice(),
  };
}
