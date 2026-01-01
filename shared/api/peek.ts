import { Encoder } from "../codec.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const peekEnd: IAuthenticatedEndpoint<Date> = {
  async encodeReq(tsAuth, body, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    for (const from of body) {
      enc.writeDate(from);
    }
    return enc;
  },
};
