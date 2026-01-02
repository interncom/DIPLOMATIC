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
  requiresRegisteredUser: boolean;
  encodeReq(
    client: IProtoClient,
    keys: HostSpecificKeyPair,
    tsAuth: EncodedAuthTimestamp,
    body: Iterable<ReqItem>,
  ): Promise<Encoder>;
  handleReq(
    host: IProtoHost,
    pubKey: PublicKey,
    dec: Decoder,
  ): Promise<Encoder | Status>;
  decodeResp(dec: Decoder): Resp;
}
