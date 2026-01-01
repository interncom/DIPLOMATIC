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

export interface IAuthenticatedEndpoint<ReqItem> {
  encodeReq(
    tsAuth: EncodedAuthTimestamp,
    body: Iterable<ReqItem>,
    keys: HostSpecificKeyPair,
    crypto: ICrypto,
    enclave: Enclave,
  ): Promise<Encoder>;
  createResp(
    pubKey: PublicKey,
    dec: Decoder,
    hostID: string,
    storage: IStorage,
    crypto: IHostCrypto,
    notifier: IWebsocketNotifier,
  ): Promise<Encoder | Status>;
  // decodeResp(dec: Decoder): Promise<IterableIterator<RespItem>>;
}
