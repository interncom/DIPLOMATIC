import { Encoder } from "./codec.ts";
import { HostSpecificKeyPair, ICrypto } from "./types.ts";
import { Enclave } from "./enclave.ts";
import { EncodedAuthTimestamp } from "./auth.ts";

export interface IAuthenticatedEndpoint<ReqItem> {
  encodeReq(
    tsAuth: EncodedAuthTimestamp,
    body: Iterable<ReqItem>,
    keyPair: HostSpecificKeyPair,
    crypto: ICrypto,
    enclave: Enclave,
  ): Promise<Encoder>;
  // encodeResp(items: Iterable<ReqItem>): Promise<Encoder>;
}
