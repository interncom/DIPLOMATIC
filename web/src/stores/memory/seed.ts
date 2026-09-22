import { Status } from "../../shared/consts";
import type { Enclave } from "../../shared/crypto/enclave";
import type { ICrypto } from "../../shared/types";
import { err, ok, type ValStat } from "../../shared/valstat";
import type { ISeedStore, SetSeedOpts } from "../../types";
import {
  cloneIdPin,
  type IdPin,
  idPinMatches,
  makeIdPin,
} from "../identityPin";

export class MemorySeedStore implements ISeedStore {
  #enclave?: Enclave;
  #crypto: ICrypto;
  #pin?: IdPin;

  constructor(crypto: ICrypto) {
    this.#crypto = crypto;
  }

  async save(
    enclave: Enclave,
    _opts?: SetSeedOpts,
  ): Promise<ValStat<Enclave>> {
    if (this.#pin !== undefined) {
      if (!(await idPinMatches(this.#crypto, enclave, this.#pin))) {
        return err(Status.HashMismatch);
      }
    } else {
      const [pin, pst] = await makeIdPin(this.#crypto, enclave);
      if (pst !== Status.Success) return err(pst);
      this.#pin = pin;
    }
    this.#enclave = enclave;
    return ok(this.#enclave);
  }

  async load() {
    return this.#enclave;
  }

  async wipe() {
    this.#enclave = undefined;
    this.#pin = undefined;
  }

  /** Test helper: snapshot of durable pin (nonce+hash only). */
  peekPin(): IdPin | undefined {
    return this.#pin === undefined ? undefined : cloneIdPin(this.#pin);
  }
}
