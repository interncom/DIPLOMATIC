import { decode, encode } from "@msgpack/msgpack";
import type { IOp, IOperationRequest, IRegistrationRequest } from "../../../cli/src/types.ts";
import { KeyPair, deriveAuthKeyPair, sign } from "./auth.ts";
import { btoh } from "../../../cli/src/lib.ts";
import { decrypt, deriveEncryptionKey, encrypt, serialize } from "./crypto-browser.ts";

async function getHostID(hostURL: string | URL): Promise<string> {
  const url = new URL(hostURL)
  url.pathname = "/id";
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw "Uh oh";
  }
  const id = await response.text();
  return id;
}

async function register(hostURL: string | URL, pubKey: Uint8Array, token: string): Promise<void> {
  const url = new URL(hostURL)
  url.pathname = "/users";
  const req: IRegistrationRequest = {
    token,
    pubKey, // TODO: check for valid pubKey length, server-side.
  };
  const reqPack = encode(req);
  const response = await fetch(url, { method: "POST", body: reqPack });
  await response.body?.cancel()
}

async function putDelta(hostURL: string | URL, cipherOp: Uint8Array, keyPair: KeyPair): Promise<string> {
  const url = new URL(hostURL)
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

async function getDelta(hostURL: string | URL, opPath: string, keyPair: KeyPair): Promise<Uint8Array> {
  const url = new URL(hostURL)
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

async function getDeltaPaths(hostURL: string | URL, begin: Date, keyPair: KeyPair): Promise<{ paths: string[] }> {
  const t = begin.toISOString();
  const path = `/ops?begin=${t}`;
  const url = new URL(hostURL)
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
  const resp = decode(respBuf) as { paths: string[] };
  return resp;
}

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
    const deltas: any[] = [];
    for (const path of paths) {
      const cipher = await getDelta(this.hostURL, path, this.hostKeyPair);
      const deltaPack = decrypt(cipher, this.encKey)
      const delta = decode(deltaPack) as IOp<"status">;
      deltas.push(delta);
    }

    return deltas;
  }
}
