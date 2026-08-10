import libsodiumCrypto from "../../crypto";
import { Enclave } from "../../shared/crypto/enclave";
import { MasterSeed } from "../../shared/seed";
import { ISeedStore, type SetSeedOpts } from "../../types";

export class MemorySeedStore implements ISeedStore {
  enclave?: Enclave;

  async save(seed: MasterSeed, _opts?: SetSeedOpts) {
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
