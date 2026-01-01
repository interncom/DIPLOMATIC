import { Encoder } from "../codec.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const userEnd: IAuthenticatedEndpoint<never> = {
  async encodeReq(tsAuth, _body, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    return enc;
  },
  requiresRegisteredUser: false,
  async handleReq(pubKey, dec, _hostID, storage, _crypto, _notifier) {
    if (!dec.done()) {
      return Status.ExtraBodyContent;
    }
    await storage.addUser(pubKey);
    const enc = new Encoder();
    return enc;
  },
};
