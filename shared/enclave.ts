import type { ICrypto, MasterSeed, DerivationSeed } from "./types.ts";
import { concat } from "./message.ts";

export class Enclave {
  private seed: MasterSeed;
  private crypto: ICrypto;

  constructor(seed: MasterSeed, crypto: ICrypto) {
    this.seed = seed;
    this.crypto = crypto;
  }

  async derive(kdm: Uint8Array): Promise<DerivationSeed> {
    const data = concat(this.seed, kdm);
    return (await this.crypto.blake3(data)) as DerivationSeed;
  }
}
