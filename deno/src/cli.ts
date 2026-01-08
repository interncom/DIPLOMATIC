import DiplomaticClientAPI from "../../shared/client.ts";
import libsodiumCrypto from "./crypto.ts";
import denoMsgpack from "./codec.ts";
import { concat, htob } from "../../shared/binary.ts";
import { kdmBytes } from "../../shared/consts.ts";
import type { KeyPair } from "../../shared/types.ts";
import { Decoder } from "../../shared/codec.ts";
import type { IMessage } from "../../shared/message.ts";
import {
  type IMessageHead,
  messageHeadCodec,
} from "../../shared/codecs/messageHead.ts";
import type { IBagPeekItem } from "../../shared/codecs/peekItem.ts";
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
  const url = new URL(hostURL);
  const enclave = new Enclave(seed as MasterSeed, libsodiumCrypto);
  const clock = { now: () => new Date() };
  const api = new DiplomaticClientAPI(
    enclave,
    libsodiumCrypto,
    url,
    0,
    url.href,
    clock,
  );

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
  seed: Uint8Array;
  crypto: ICrypto;
  constructor(
    api: DiplomaticClientAPI,
    seed: Uint8Array,
    encKey: Uint8Array,
    hostURL: URL,
  ) {
    this.api = api;
    this.seed = seed;
    this.crypto = libsodiumCrypto;
    this.enclave = new Enclave(seed as MasterSeed, libsodiumCrypto);
    this.encKey = encKey;
    this.hostURL = hostURL;
  }

  async register() {
    this.hostID = this.hostURL.href;
    await this.api.register();
    const derivationSeed = await this.enclave.derive(this.hostID, 0);
    this.hostKeyPair = await this.crypto.deriveEd25519KeyPair(derivationSeed);
  }

  async push(msg: IMessage, idx: number = 0) {
    const results = [...(await this.api.push([msg]))];
    return results[0];
  }

  async peek(begin: Date, idx: number = 0): Promise<IBagPeekItem[]> {
    return [...(await this.api.peek(begin))];
  }

  async pull(hashes: Uint8Array[]): Promise<IMessageDecoded[]> {
    const bag = await this.api.pull(hashes);
    const messages: IMessageDecoded[] = [];
    for (const env of bag) {
      const kdm = env.hash.slice(0, kdmBytes);
      const encKey = await libsodiumCrypto.blake3(concat(this.seed, kdm));
      const body = await libsodiumCrypto.decryptXSalsa20Poly1305(
        encKey,
        env.bodyCph,
      );
      const dec = new Decoder(decrypted);
      const msgHead: IMessageHead = messageHeadCodec.decode(dec);
      let bod: Uint8Array | undefined;
      if (msgHead.len > 0) {
        bod = dec.readBytes(msgHead.len);
      }
      const msg: IMessage = { ...msgHead, bod };
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
