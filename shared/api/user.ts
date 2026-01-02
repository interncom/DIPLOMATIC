import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const userEnd: IAuthenticatedEndpoint<never, void> = {
  async encodeReq(_client, _keys, tsAuth, _body, reqEnc) {
    reqEnc.writeBytes(tsAuth);
  },
  requiresRegisteredUser: false,
  async handleReq(host, pubKey, reqDec, _respEnc) {
    const { storage } = host;
    if (!reqDec.done()) {
      return Status.ExtraBodyContent;
    }
    await storage.addUser(pubKey);
    return Status.Success;
  },
  decodeResp(_respDec) {
    return;
  },
};
