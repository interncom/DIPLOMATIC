import type {
  ICrypto,
  IListDeltasResponse,
  IMsgpackCodec,
  IOperationRequest,
  IRegistrationRequest,
  KeyPair,
} from "./types.ts";
import { btoh } from "./lib.ts";

export default class DiplomaticClientAPI {
  codec: IMsgpackCodec;
  crypto: ICrypto;
  constructor(codec: IMsgpackCodec, crypto: ICrypto) {
    this.codec = codec;
    this.crypto = crypto;
  }

  async getHostID(hostURL: URL): Promise<string> {
    const url = new URL(hostURL);
    url.pathname = "/id";
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw "Uh oh";
    }
    const id = await response.text();
    return id;
  }

  async register(
    hostURL: URL,
    pubKey: Uint8Array,
    token: string,
  ): Promise<void> {
    const url = new URL(hostURL);
    url.pathname = "/users";
    const req: IRegistrationRequest = {
      token,
      pubKey, // TODO: check for valid pubKey length, server-side.
    };
    const reqPack = this.codec.encode(req);
    const response = await fetch(url, {
      method: "POST",
      body: reqPack.slice(0),
    });
    await response.body?.cancel();
  }

  // async push(hostURL: URL, ops: Uint8Array, keyPair: KeyPair): Promise<string> {
  //   const url = new URL(hostURL);
  //   url.pathname = "/ops";

  //   const req: IOperationRequest = {
  //     cipher: cipherOp,
  //   };
  //   const reqPack = this.codec.encode(req);

  //   const sig = await this.crypto.signEd25519(req.cipher, keyPair.privateKey);
  //   const sigHex = btoh(sig);
  //   const keyHex = btoh(keyPair.publicKey);

  //   const response = await fetch(url, {
  //     method: "POST",
  //     body: reqPack,
  //     headers: {
  //       "X-DIPLOMATIC-SIG": sigHex,
  //       "X-DIPLOMATIC-KEY": keyHex,
  //     },
  //   });
  //   if (!response.ok) {
  //     throw "Uh oh";
  //   }
  //   const opPath = await response.text();
  //   return opPath;
  // }
}
