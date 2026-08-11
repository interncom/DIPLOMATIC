import type { Enclave } from "../../shared/crypto/enclave";
import type { ISeedStore, SetSeedOpts } from "../../types";

export class MemorySeedStore implements ISeedStore {
  enclave?: Enclave;

  async save(enclave: Enclave, _opts?: SetSeedOpts) {
    this.enclave = enclave;
    return this.enclave;
  }

  async load() {
    return this.enclave;
  }

  async wipe() {
    this.enclave = undefined;
  }
}
