import type { ICrypto, MasterSeed, DerivationSeed } from "./types.ts";
import { concat } from "./lib.ts";

export class Enclave {
  private seed: MasterSeed;
  private crypto: ICrypto;

  constructor(seed: MasterSeed, crypto: ICrypto) {
    this.seed = seed;
    this.crypto = crypto;
  }

  async deriveFromKDM(kdm: Uint8Array): Promise<DerivationSeed> {
    const data = concat(this.seed, kdm);
    return (await this.crypto.blake3(data)) as DerivationSeed;
  }

  async derive(keyPath: string, idx = 0): Promise<DerivationSeed> {
    const keyPathBytes = new TextEncoder().encode(keyPath);
    const indexBytes = new Uint8Array(8);
    new DataView(indexBytes.buffer).setBigUint64(0, BigInt(idx), false);
    const kdm = concat(keyPathBytes, indexBytes);
    return await this.deriveFromKDM(kdm);
  }
}
