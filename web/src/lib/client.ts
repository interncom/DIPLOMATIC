import { decode } from "@msgpack/msgpack";
import type { IOp } from "../../../cli/src/types.ts";
import { decrypt, deriveEncryptionKey, encrypt, serialize } from "./crypto-browser.ts";
import { getHostID, register, putDelta, getDeltaPaths, getDelta } from "./api.ts";
import { type KeyPair, deriveAuthKeyPair } from "./auth.ts";

export default class DiplomaticClient {
  seed: Uint8Array;
  encKey: Uint8Array;
  hostURL?: URL;
  hostKeyPair?: KeyPair;

  constructor(seed: Uint8Array) {
    this.seed = seed;
    this.encKey = deriveEncryptionKey(seed);
  }

  async register(hostURL: string) {
    this.hostURL = new URL(hostURL);
    const hostID = await getHostID(hostURL);
    this.hostKeyPair = deriveAuthKeyPair(hostID, this.seed);
    await register(hostURL, this.hostKeyPair.publicKey, "tok123");
  }

  async putDelta(delta: IOp<"status">) {
    if (!this.hostURL || !this.hostKeyPair) {
      return [];
    }
    const packed = serialize(delta);
    const cipherOp = encrypt(packed, this.encKey);
    await putDelta(this.hostURL, cipherOp, this.hostKeyPair);
  }

  async getDeltas(begin: Date): Promise<IOp<"status">[]> {
    if (!this.hostURL || !this.hostKeyPair) {
      return [];
    }
    const pathResp = await getDeltaPaths(this.hostURL, begin, this.hostKeyPair);
    const paths = pathResp.paths;
    const deltas: IOp<"status">[] = [];
    for (const path of paths) {
      const cipher = await getDelta(this.hostURL, path, this.hostKeyPair);
      const deltaPack = decrypt(cipher, this.encKey)
      const delta = decode(deltaPack) as IOp<"status">;
      deltas.push(delta);
    }

    return deltas;
  }

  async processDeltas(begin: Date, updatedAt: string | undefined, apply: (delta: IOp<"status">) => void) {
    this.getDeltas(begin).then(deltas => {
      for (const delta of deltas) {
        if (!updatedAt || delta.ts > updatedAt) {
          apply(delta);
        }
        // console.log("delta", delta, updatedAt);
      }
    });
  }
}
