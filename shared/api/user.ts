import { validateAuthTimestamp } from "../auth.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const userEnd: IAuthenticatedEndpoint<never, void> = {
  async encodeReq(_client, _keys, authTS, _body, reqEnc) {
    reqEnc.writeStruct(authTimestampCodec, authTS);
  },
  async handleReq(host, reqDec, _respEnc) {
    const { storage } = host;

    const authTS = reqDec.readStruct(authTimestampCodec);
    const status = await validateAuthTimestamp(authTS, host.crypto);
    if (status !== Status.Success) {
      return status;
    }
    const { pubKey } = authTS;

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
