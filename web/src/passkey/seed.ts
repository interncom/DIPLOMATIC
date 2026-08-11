// ISeedStore backed by WebAuthn largeBlob (OS-held passkey storage).
// Seed encode/decode/UV write-read is owned by Enclave — never handled here.

import { Enclave } from "../shared/crypto/enclave";
import { Status } from "../shared/consts";
import type { ICrypto } from "../shared/types";
import { err, ok, type ValStat } from "../shared/valstat";
import type { ISeedStore, SetSeedOpts } from "../types";
import { LargeBlob, type LargeBlobRp } from "./largeBlob";

export { defaultWebAuthnRpId } from "./webauthn";
export {
  LargeBlob,
  type LargeBlobCreateOpts,
  type LargeBlobRp,
} from "./largeBlob";

export type PasskeySeedStoreOpts = LargeBlobRp & {
  crypto: ICrypto;
  credId?: Uint8Array;
};

/**
 * ISeedStore backed by largeBlob. Session secret is always {@link Enclave}.
 * Persist uses {@link Enclave.persistToLargeBlob} / {@link Enclave.fromLargeBlob}.
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

  async save(enclave: Enclave, opts?: SetSeedOpts): Promise<Enclave> {
    if (opts?.persist !== true) {
      this.#enclave = enclave;
      return this.#enclave;
    }
    const [id, st] = await enclave.persistToLargeBlob([], {
      rpId: this.#rpId,
      rpName: this.#rpName,
      credId: this.#credId,
    });
    if (st !== Status.Success || id === undefined) {
      return Promise.reject(new Error(`persistToLargeBlob status ${st}`));
    }
    this.#credId = id;
    this.#enclave = enclave;
    return this.#enclave;
  }

  async load(): Promise<Enclave | void> {
    return this.#enclave;
  }

  async unlock(): Promise<ValStat<Enclave>> {
    const id = this.#credId;
    if (id === undefined) return err(Status.MissingSeed);
    const [out, st] = await Enclave.fromLargeBlob(this.#crypto, {
      rpId: this.#rpId,
      rpName: this.#rpName,
      credId: id,
    });
    if (st !== Status.Success || out === undefined) return err(st);
    this.#enclave = out.enclave;
    return ok(out.enclave);
  }

  async wipe(): Promise<void> {
    const id = this.#credId;
    if (id !== undefined) {
      const st = await Enclave.clearLargeBlob(id, { rpId: this.#rpId });
      if (st !== Status.Success) {
        return Promise.reject(new Error(`clearLargeBlob status ${st}`));
      }
    }
    this.#enclave = undefined;
    this.#credId = undefined;
  }
}
