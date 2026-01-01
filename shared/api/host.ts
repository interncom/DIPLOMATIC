import { Encoder } from "../codec.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const hostEnd: IAuthenticatedEndpoint<never> = {
  async encodeReq(tsAuth, _body, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    return enc;
  },
};
