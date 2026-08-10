// ISeedStore backed by WebAuthn largeBlob (OS-held passkey storage).

import { Enclave } from "../shared/crypto/enclave";
import { Status } from "../shared/consts";
import type { MasterSeed } from "../shared/seed";
import type { ICrypto } from "../shared/types";
import { err, ok, type ValStat } from "../shared/valstat";
import type { ISeedStore, SetSeedOpts } from "../types";
import { LargeBlob, type LargeBlobRp } from "./largeBlob";

export { defaultWebAuthnRpId } from "./webauthn";
export {
  LargeBlob,
  type LargeBlobCreateOpts,
  type LargeBlobRp,
  type LargeBlobUnlock,
} from "./largeBlob";

export type PasskeySeedStoreOpts = LargeBlobRp & {
  /** Crypto backend for enclave ops (noble, libsodium, …). */
  crypto: ICrypto;
  credId?: Uint8Array;
};

/**
 * ISeedStore backed by largeBlob.
 * - {@link save} creates (or reuses) cred + writes seed (gestures).
 * - {@link load} returns in-memory enclave only; call {@link unlock} after restart.
 * - Local {@link credId} must be persisted by the app across sessions.
 * - {@link wipe} overwrites largeBlob with zeros (UV), then drops memory + credId.
 *   Does not delete the WebAuthn credential from the authenticator.
 *
 * {@link ISeedStore.save} / {@link wipe} keep Promise shapes required by the
 * store interface; failures surface as rejected promises with a Status message.
 * Prefer {@link unlock} which returns ValStat.
 */
export class PasskeySeedStore implements ISeedStore {
  #crypto: ICrypto;
  #enclave: Enclave | undefined;
  #credId: Uint8Array | undefined;
  #rpId: string | undefined;
  #rpName: string | undefined;

  constructor(opts: PasskeySeedStoreOpts) {
    this.#crypto = opts.crypto;
    this.#rpId = opts.rpId;
    this.#rpName = opts.rpName;
    if (opts.credId !== undefined) {
      this.#credId = opts.credId.slice();
    }
  }

  get credId(): Uint8Array | undefined {
    if (this.#credId === undefined) return undefined;
    return this.#credId.slice();
  }

  setCredId(credId: Uint8Array | undefined): void {
    this.#credId = credId === undefined ? undefined : credId.slice();
  }

  async save(seed: MasterSeed, opts?: SetSeedOpts): Promise<Enclave> {
    // Default memory-only; persist:true writes largeBlob (this store's durable path).
    if (opts?.persist !== true) {
      this.#enclave = new Enclave(seed, this.#crypto);
      return this.#enclave;
    }
    const rp = { rpId: this.#rpId, rpName: this.#rpName };
    let id = this.#credId;
    if (id === undefined) {
      const [created, cst] = await LargeBlob.createCred(rp);
      if (cst !== Status.Success || created === undefined) {
        return Promise.reject(new Error(`largeBlob createCred status ${cst}`));
      }
      id = created;
      this.#credId = id;
    }
    const wst = await LargeBlob.writeSeed(id, seed, rp);
    if (wst !== Status.Success) {
      return Promise.reject(new Error(`largeBlob writeSeed status ${wst}`));
    }
    this.#enclave = new Enclave(seed, this.#crypto);
    return this.#enclave;
  }

  async load(): Promise<Enclave | void> {
    return this.#enclave;
  }

  /** User-gesture unlock after cold start (needs {@link credId}). */
  async unlock(): Promise<ValStat<Enclave>> {
    const id = this.#credId;
    if (id === undefined) return err(Status.MissingSeed);
    const [seed, st] = await LargeBlob.readSeed(id, { rpId: this.#rpId });
    if (st !== Status.Success || seed === undefined) return err(st);
    this.#enclave = new Enclave(seed, this.#crypto);
    return ok(this.#enclave);
  }

  async wipe(): Promise<void> {
    const id = this.#credId;
    if (id !== undefined) {
      const st = await LargeBlob.clearSeed(id, { rpId: this.#rpId });
      if (st !== Status.Success) {
        return Promise.reject(new Error(`largeBlob clearSeed status ${st}`));
      }
    }
    this.#enclave = undefined;
    this.#credId = undefined;
  }
}
