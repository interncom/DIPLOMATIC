import { Encoder } from "../codec.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

type BagHash = Uint8Array;
export const pullEnd: IAuthenticatedEndpoint<BagHash> = {
  async encodeReq(tsAuth, hashes, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeBytesSeq(hashes);
    return enc;
  },
};
