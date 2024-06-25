import { encode, decode } from "@msgpack/msgpack";
import { btoh } from "../../../shared/lib";
import type { IRegistrationRequest, IOperationRequest, IGetDeltaPathsResponse, KeyPair } from "../../../shared/types";
import libsodiumCrypto from "./crypto";

export async function getHostID(hostURL: string | URL): Promise<string> {
  const url = new URL(hostURL)
  url.pathname = "/id";
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw "Uh oh";
  }
  const id = await response.text();
  return id;
}

export async function register(hostURL: string | URL, pubKey: Uint8Array, token: string): Promise<void> {
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

export async function putDelta(hostURL: string | URL, cipherOp: Uint8Array, keyPair: KeyPair): Promise<string> {
  const url = new URL(hostURL)
  url.pathname = "/ops";

  const req: IOperationRequest = {
    cipher: cipherOp,
  };
  const reqPack = encode(req);

  const sig = await libsodiumCrypto.signEd25519(req.cipher, keyPair.privateKey);
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

export async function getDelta(hostURL: string | URL, opPath: string, keyPair: KeyPair): Promise<Uint8Array> {
  const url = new URL(hostURL)
  url.pathname = `/ops/${opPath}`;

  const sig = await libsodiumCrypto.signEd25519(opPath, keyPair.privateKey);
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

export async function getDeltaPaths(hostURL: string | URL, begin: Date, keyPair: KeyPair): Promise<IGetDeltaPathsResponse> {
  const t = begin.toISOString();
  const path = `/ops?begin=${t}`;
  const url = new URL(hostURL)
  url.pathname = path;

  const sigPath = `/ops%3Fbegin=${t}`;
  const sig = await libsodiumCrypto.signEd25519(sigPath, keyPair.privateKey);
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
