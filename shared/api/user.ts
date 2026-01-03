import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const userEnd: IAuthenticatedEndpoint<never, void> = {
  requiresRegisteredUser: false,
  async encodeReq(_client, _keys, authTS, _body, reqEnc) {
    reqEnc.writeStruct(authTimestampCodec, authTS);
  },
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
