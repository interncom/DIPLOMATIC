import { Encoder } from "../codec.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const userEnd: IAuthenticatedEndpoint<never, void> = {
  async encodeReq(_client, _keys, tsAuth, _body) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    return enc;
  },
  requiresRegisteredUser: false,
  async handleReq(host, pubKey, dec) {
    const { storage } = host;
    if (!dec.done()) {
      return Status.ExtraBodyContent;
    }
    await storage.addUser(pubKey);
    const enc = new Encoder();
    return enc;
  },
  decodeResp(_dec) {
    return;
  },
};
