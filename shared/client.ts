import type { ICrypto, IListDeltasResponse, IMsgpackCodec, IOperationRequest, IRegistrationRequest, KeyPair } from "./types.ts";
import { btoh } from "./lib.ts";

export default class DiplomaticClientAPI {
  codec: IMsgpackCodec;
  crypto: ICrypto;
  constructor(codec: IMsgpackCodec, crypto: ICrypto) {
    this.codec = codec;
    this.crypto = crypto;
  }

  async getHostID(hostURL: URL): Promise<string> {
    const url = new URL(hostURL)
    url.pathname = "/id";
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw "Uh oh";
    }
    const id = await response.text();
    return id;
  }

  async register(hostURL: URL, pubKey: Uint8Array, token: string): Promise<void> {
    const url = new URL(hostURL)
    url.pathname = "/users";
    const req: IRegistrationRequest = {
      token,
      pubKey, // TODO: check for valid pubKey length, server-side.
    };
    const reqPack = this.codec.encode(req);
    const response = await fetch(url, { method: "POST", body: reqPack });
    await response.body?.cancel()
  }

  async putDelta(hostURL: URL, cipherOp: Uint8Array, keyPair: KeyPair): Promise<string> {
    const url = new URL(hostURL)
    url.pathname = "/ops";

    const req: IOperationRequest = {
      cipher: cipherOp,
    };
    const reqPack = this.codec.encode(req);

    const sig = await this.crypto.signEd25519(req.cipher, keyPair.privateKey);
    const sigHex = btoh(sig);
    const keyHex = btoh(keyPair.publicKey);

    const response = await fetch(url, {
      method: "POST", body: reqPack, headers: {
        "X-DIPLOMATIC-SIG": sigHex,
        "X-DIPLOMATIC-KEY": keyHex,
      }
    });
    if (!response.ok) {
      throw "Uh oh";
    }
    const opPath = await response.text();
    return opPath;
  }

  async getDelta(hostURL: URL, sha256: Uint8Array, keyPair: KeyPair): Promise<Uint8Array> {
    const url = new URL(hostURL)
    const opPath = btoh(sha256);
    url.pathname = `/ops/${opPath}`;

    const sig = await this.crypto.signEd25519(opPath, keyPair.privateKey);
    const sigHex = btoh(sig);
    const keyHex = btoh(keyPair.publicKey);
    const response = await fetch(url, {
      method: "GET", headers: {
        "X-DIPLOMATIC-SIG": sigHex,
        "X-DIPLOMATIC-KEY": keyHex,
      }
    });
    if (!response.ok) {
      throw "Uh oh";
    }
    const respBuf = await response.arrayBuffer();
    const resp = this.codec.decode(respBuf) as { cipher: Uint8Array };
    if (resp.cipher === undefined) {
      throw "Missing cipher";
    }
    return resp.cipher;
  }

  async listDeltas(hostURL: URL, begin: Date, keyPair: KeyPair): Promise<IListDeltasResponse> {
    const t = begin.toISOString();
    const path = `/ops?begin=${t}`;
    const url = new URL(hostURL)
    url.pathname = path;

    const sigPath = `/ops%3Fbegin=${t}`;
    const sig = await this.crypto.signEd25519(sigPath, keyPair.privateKey);
    const sigHex = btoh(sig);
    const keyHex = btoh(keyPair.publicKey);
    const response = await fetch(url, {
      method: "GET", headers: {
        "X-DIPLOMATIC-SIG": sigHex,
        "X-DIPLOMATIC-KEY": keyHex,
      }
    });
    if (!response.ok) {
      throw "Uh oh";
    }
    const respBuf = await response.arrayBuffer();
    const resp = this.codec.decode(respBuf) as IListDeltasResponse;
    return resp;
  }
}
