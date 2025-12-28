import DiplomaticClientAPI from "../../shared/client.ts";
import libsodiumCrypto from "./crypto.ts";
import denoMsgpack from "./codec.ts";
import { htob, concat } from "../../shared/lib.ts";
import type { KeyPair } from "../../shared/types.ts";
import type { IMessage } from "../../shared/message.ts";
import { decodeOp } from "../../shared/message.ts";
import type { IEnvelopeHeader } from "../../shared/envelope.ts";
import { Enclave } from "../../shared/enclave.ts";

export interface IMessageDecoded {
  eid: Uint8Array;
  clk: Date;
  ctr: number;
  len: number;
  bod?: any;
}

export async function initCLI() {
  const hostURL = Deno.env.get("DIPLOMATIC_HOST_URL");
  const seedHex = Deno.env.get("DIPLOMATIC_SEED_HEX");
  if (!hostURL) {
    throw "Missing DIPLOMATIC_HOST_URL env var";
  }
  if (!seedHex) {
    throw "Missing DIPLOMATIC_SEED_HEX env var";
  }

  const seed = htob(seedHex);
  const encKey = await libsodiumCrypto.deriveXSalsa20Poly1305Key(seed);

  const api = new DiplomaticClientAPI(libsodiumCrypto);
  const url = new URL(hostURL);

  const client = new DiplomaticClientCLI(api, seed, encKey, url);
  await client.register();
  return client;
}

export class DiplomaticClientCLI {
  api: DiplomaticClientAPI;
  enclave: Enclave;
  encKey: Uint8Array;
  hostURL: URL;
  hostID?: string;
  hostKeyPair?: KeyPair;
  constructor(
    api: DiplomaticClientAPI,
    seed: Uint8Array,
    encKey: Uint8Array,
    hostURL: URL,
  ) {
    this.api = api;
    this.enclave = new Enclave(seed as MasterSeed, libsodiumCrypto);
    this.encKey = encKey;
    this.hostURL = hostURL;
  }

  async register() {
    const hostID = await this.api.getHostID(this.hostURL);
    this.hostID = hostID;
    const now = new Date();
    await this.api.register(this.hostURL, hostID, 0, now);
    const derivationSeed = await this.enclave.derive(hostID, idx);
    this.hostKeyPair = await this.crypto.deriveEd25519KeyPair(derivationSeed);
  }

  async push(msg: IMessage, idx: number = 0) {
    const now = new Date();
    const hostID = this.hostID || (await this.api.getHostID(this.hostURL));
    const results = [
      ...(await this.api.push(
        this.hostURL,
        [msg],
        this.seed,
        hostID,
        idx,
        now,
      )),
    ];
    return results[0];
  }

  async peek(begin: Date, idx: number = 0): Promise<IEnvelopeHeader[]> {
    const hostID = this.hostID || (await this.api.getHostID(this.hostURL));
    const now = new Date();
    return [
      ...(await this.api.peek(
        this.hostURL,
        begin.getTime(),
        this.seed,
        hostID,
        idx,
        now,
      )),
    ];
  }

  async pull(hashes: Uint8Array[]): Promise<IMessageDecoded[]> {
    const envelopes = await this.api.pull(
      this.hostURL,
      hashes,
      this.seed,
      this.hostID || (await this.api.getHostID(this.hostURL)),
      0,
      new Date(),
    );
    const messages: IMessageDecoded[] = [];
    for (const env of envelopes) {
      const encKey = await libsodiumCrypto.blake3(concat(this.seed, env.kdm));
      const decrypted = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
        env.cipher,
        encKey,
      );
      const msg = await decodeOp(decrypted);
      const decodedMsg: IMessageDecoded = {
        eid: msg.eid,
        clk: msg.clk,
        ctr: msg.ctr,
        len: msg.len,
        bod: msg.bod ? denoMsgpack.decode(msg.bod) : undefined,
      };
      messages.push(decodedMsg);
    }
    return messages;
  }
}
