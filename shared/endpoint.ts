import { Decoder, Encoder } from "./codec.ts";
import {
  HostSpecificKeyPair,
  ICrypto,
  IHostCrypto,
  IStorage,
  IWebsocketNotifier,
  PublicKey,
} from "./types.ts";
import { Enclave } from "./enclave.ts";
import { EncodedAuthTimestamp } from "./auth.ts";
import { Status } from "./consts.ts";

interface IProtoClient {
  crypto: ICrypto;
  enclave: Enclave;
}

interface IProtoHost {
  hostID: string;
  storage: IStorage;
  crypto: IHostCrypto;
  notifier: IWebsocketNotifier;
}

export interface IAuthenticatedEndpoint<ReqItem, Resp> {
  // requiresRegisteredUser indicates if this endpoint requires a user.
  requiresRegisteredUser: boolean;

  // encodeReq writes request data to the provided reqEnc.
  encodeReq(
    client: IProtoClient,
    keys: HostSpecificKeyPair,
    tsAuth: EncodedAuthTimestamp,
    body: Iterable<ReqItem>,
    reqEnc: Encoder,
  ): Promise<void>;

  // handleReq reads request data from reqDec and writes to respEnc.
  handleReq(
    host: IProtoHost,
    pubKey: PublicKey,
    reqDec: Decoder,
    respEnc: Encoder,
  ): Promise<Status>;

  // decodeResp reads response data from respDeck and parses it.
  decodeResp(respDec: Decoder): Resp;
}
