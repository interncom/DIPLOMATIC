// Client class to facilitate building deno CLI apps.

import DiplomaticClientAPI from "../../shared/client.ts";
import libsodiumCrypto from "./crypto.ts";
import denoMsgpack from "./codec.ts";
import { htob } from "../../shared/lib.ts";
import type { IGetDeltaPathsResponse, IOp, KeyPair } from "../../shared/types.ts";
import { isOp } from "../../shared/ops.ts";

export async function initCLI() {
  const hostURL = Deno.env.get("DIPLOMATIC_HOST_URL");
  const seedHex = Deno.env.get("DIPLOMATIC_SEED_HEX");
  if (!hostURL) {
    throw "Missing DIPLOMATIC_HOST_URL env var"
  }
  if (!seedHex) {
    throw "Missing DIPLOMATIC_SEED_HEX env var"
  }

  const seed = htob(seedHex);
  const encKey = await libsodiumCrypto.deriveXSalsa20Poly1305Key(seed);

  const api = new DiplomaticClientAPI(denoMsgpack, libsodiumCrypto);
  const url = new URL(hostURL);

  const client = new DiplomaticClientCLI(api, seed, encKey, url);
  await client.register();
  return client;
}

export class DiplomaticClientCLI {
  api: DiplomaticClientAPI;
  seed: Uint8Array;
  encKey: Uint8Array;
  hostURL: URL;
  hostKeyPair?: KeyPair;
  constructor(api: DiplomaticClientAPI, seed: Uint8Array, encKey: Uint8Array, hostURL: URL) {
    this.api = api;
    this.seed = seed;
    this.encKey = encKey;
    this.hostURL = hostURL;
  }

  async register() {
    const regToken = "tok123";
    const hostID = await this.api.getHostID(this.hostURL);
    const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(this.seed, hostID);
    await this.api.register(this.hostURL, keyPair.publicKey, regToken);
    this.hostKeyPair = keyPair;
  }

  async push(op: IOp) {
    if (!this.hostKeyPair) {
      return;
    }
    const packed = denoMsgpack.encode(op);
    const cipherOp = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(packed, this.encKey);
    await this.api.putDelta(this.hostURL, cipherOp, this.hostKeyPair);
  }

  async list(begin: Date): Promise<IGetDeltaPathsResponse | undefined> {
    if (!this.hostKeyPair) {
      return;
    }
    const resp = await this.api.getDeltaPaths(this.hostURL, begin, this.hostKeyPair);
    return resp;
  }

  async pull(path: string): Promise<IOp | undefined> {
    if (!this.hostKeyPair) {
      return;
    }
    const cipher = await this.api.getDelta(this.hostURL, path, this.hostKeyPair);
    const packed = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(cipher, this.encKey);
    const op = denoMsgpack.decode(packed);
    if (!isOp(op)) {
      return;
    }
    return op;
  }
}
