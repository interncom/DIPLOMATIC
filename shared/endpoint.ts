import { Decoder, Encoder } from "./codec.ts";
import {
  HostSpecificKeyPair,
  ICrypto,
  IHostCrypto,
  IStorage,
  IWebsocketNotifier,
} from "./types.ts";
import { Enclave } from "./enclave.ts";
import { Status } from "./consts.ts";
import { IClock } from "./clock.ts";
import { IAuthTimestamp } from "./codecs/authTimestamp.ts";
import { makeAuthTimestamp } from "./auth.ts";

interface IProtoClient {
  crypto: ICrypto;
  enclave: Enclave;
  clock: IClock;
}

interface IProtoHost {
  hostID: string;
  storage: IStorage;
  crypto: IHostCrypto;
  notifier: IWebsocketNotifier;
  clock: IClock;
}

export interface IAuthenticatedEndpoint<ReqItem, Resp> {
  // encodeReq writes request data to the provided reqEnc.
  encodeReq(
    client: IProtoClient,
    keys: HostSpecificKeyPair,
    authTS: IAuthTimestamp,
    body: Iterable<ReqItem>,
    reqEnc: Encoder,
  ): Promise<void>;

  // handleReq reads request data from reqDec and writes to respEnc.
  handleReq(
    host: IProtoHost,
    reqDec: Decoder,
    respEnc: Encoder,
  ): Promise<Status>;

  // decodeResp reads response data from respDeck and parses it.
  decodeResp(respDec: Decoder): Resp;
}

export interface IAuthData {
  keys: HostSpecificKeyPair;
  authTS: IAuthTimestamp;
}

export async function authData(
  host: IProtoClient,
  keyPath: string,
  idx: number,
): Promise<IAuthData> {
  const { clock, crypto, enclave } = host;
  const now = clock.now();
  const derivSeed = await enclave.derive(keyPath, idx);
  const keys = await crypto.deriveEd25519KeyPair(derivSeed);
  const authTS = await makeAuthTimestamp(keys, now, crypto);
  return { keys: keys as HostSpecificKeyPair, authTS };
}
