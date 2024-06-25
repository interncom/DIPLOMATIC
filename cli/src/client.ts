import { decode, encode } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import type { IGetDeltaPathsResponse, IOperationRequest, IRegistrationRequest } from "./types.ts";
import { type KeyPair, sign } from "./auth.ts";
import { btoh } from "./lib.ts";

export default class DiplomaticClient {
  hostURL: URL;
  constructor(hostURL: URL) {
    this.hostURL = hostURL;
  }

  async getHostID(): Promise<string> {
    const url = new URL(this.hostURL)
    url.pathname = "/id";
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw "Uh oh";
    }
    const id = await response.text();
    return id;
  }

  async register(pubKey: Uint8Array, token: string): Promise<void> {
    const url = new URL(this.hostURL)
    url.pathname = "/users";
    const req: IRegistrationRequest = {
      token,
      pubKey, // TODO: check for valid pubKey length, server-side.
    };
    const reqPack = encode(req);
    const response = await fetch(url, { method: "POST", body: reqPack });
    await response.body?.cancel()
  }

  async putDelta(cipherOp: Uint8Array, keyPair: KeyPair): Promise<string> {
    const url = new URL(this.hostURL)
    url.pathname = "/ops";

    const req: IOperationRequest = {
      cipher: cipherOp,
    };
    const reqPack = encode(req);

    const sig = sign(req.cipher, keyPair);
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

  async getDelta(opPath: string, keyPair: KeyPair): Promise<Uint8Array> {
    const url = new URL(this.hostURL)
    url.pathname = `/ops/${opPath}`;

    const sig = sign(opPath, keyPair);
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
    const resp = decode(respBuf) as { cipher: Uint8Array };
    if (resp.cipher === undefined) {
      throw "Missing cipher";
    }
    return resp.cipher;
  }

  async getDeltaPaths(begin: Date, keyPair: KeyPair): Promise<IGetDeltaPathsResponse> {
    const t = begin.toISOString();
    const path = `/ops?begin=${t}`;
    const url = new URL(this.hostURL)
    url.pathname = path;

    const sigPath = `/ops%3Fbegin=${t}`;
    const sig = sign(sigPath, keyPair);
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
    const resp = decode(respBuf) as IGetDeltaPathsResponse;
    return resp;
  }
}
