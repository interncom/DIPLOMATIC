import { validateAuthTimestamp } from "../auth.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const userEnd: IAuthenticatedEndpoint<never, void> = {
  async encodeReq(_client, _keys, authTS, _body, reqEnc) {
    const status = reqEnc.writeStruct(authTimestampCodec, authTS);
    return status;
  },
  async handleReq(host, reqDec, _respEnc) {
    const { storage } = host;

    const [authTS, status] = reqDec.readStruct(authTimestampCodec);
    if (status !== Status.Success) return status;
    const validStatus = await validateAuthTimestamp(
      authTS,
      host.crypto,
      host.clock,
    );
    if (validStatus !== Status.Success) {
      return validStatus;
    }
    const { pubKey } = authTS;

    if (!reqDec.done()) {
      return Status.ExtraBodyContent;
    }
    const [_, addStatus] = await storage.addUser(pubKey);
    if (addStatus !== Status.Success) return addStatus;
    return Status.Success;
  },
  decodeResp(_respDec) {
    return [undefined, Status.Success];
  },
};
