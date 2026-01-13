import libsodiumCrypto from "../../crypto";
import { Enclave } from "../../shared/enclave";
import { MasterSeed } from "../../shared/types";
import { ISeedStore } from "../../types";

export class MemorySeedStore implements ISeedStore {
  enclave?: Enclave;

  async save(seed: MasterSeed) {
    this.enclave = new Enclave(seed, libsodiumCrypto);
    return this.enclave;
  }

  async load() {
    return this.enclave;
  }

  async wipe() {
    this.enclave = undefined;
  }
}
