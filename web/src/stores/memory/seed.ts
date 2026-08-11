import type { Enclave } from "../../shared/crypto/enclave";
import type { ICrypto } from "../../shared/types";
import type { ISeedStore, SetSeedOpts } from "../../types";
import {
  cloneIdPin,
  idPinMatches,
  makeIdPin,
  type IdPin,
} from "../identityPin";

export class MemorySeedStore implements ISeedStore {
  enclave?: Enclave;
  #crypto: ICrypto;
  #pin?: IdPin;

  constructor(crypto: ICrypto) {
    this.#crypto = crypto;
  }

  async save(enclave: Enclave, _opts?: SetSeedOpts) {
    if (this.#pin !== undefined) {
      if (!(await idPinMatches(this.#crypto, enclave, this.#pin))) {
        throw new Error(
          "[DIPLOMATIC] seed does not match this device's identity " +
            "(local data was created with a different master seed)",
        );
      }
    } else {
      this.#pin = await makeIdPin(this.#crypto, enclave);
    }
    this.enclave = enclave;
    return this.enclave;
  }

  async load() {
    return this.enclave;
  }

  async wipe() {
    this.enclave = undefined;
    this.#pin = undefined;
  }

  /** Test helper: snapshot of durable pin (nonce+hash only). */
  peekPin(): IdPin | undefined {
    return this.#pin === undefined ? undefined : cloneIdPin(this.#pin);
  }
}
