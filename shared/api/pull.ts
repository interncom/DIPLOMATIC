import { validateAuthTimestamp } from "../auth.ts";
import { authTimestampCodec, IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { type IBagPullItem, pullItemCodec } from "../codecs/pullItem.ts";
import { hashBytes, Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { Hash } from "../types.ts";

export const pullEnd: IAuthenticatedEndpoint<
  Hash,
  IBagPullItem[]
> = {
  async encodeReq(_client, _keys, authTS, hashes, reqEnc): Promise<Status> {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    reqEnc.writeBytesSeq(hashes);
    return Status.Success;
  },
  async handleReq(host, reqDec, respEnc) {
    const { storage } = host;

    const [authTS, s] = reqDec.readStruct(authTimestampCodec);
    if (s !== Status.Success) return s;
    const validStatus = await validateAuthTimestamp(
      authTS,
      host.crypto,
      host.clock,
    );
    if (validStatus !== Status.Success) return validStatus;
    const { pubKey } = authTS;

    const [hasUser, hasStatus] = await storage.hasUser(pubKey);
    if (hasStatus !== Status.Success) return hasStatus;
    if (!hasUser) return Status.UserNotRegistered;

    const [hashes, s3] = reqDec.readBytesSeq(hashBytes);
    if (s3 !== Status.Success) return s3;
    for (const headHash of hashes) {
      const [bodyCph, getStatus] = await storage.getBody(
        pubKey,
        headHash as Hash,
      );
      if (getStatus !== Status.Success) return getStatus;
      if (bodyCph) {
        const item: IBagPullItem = { hash: headHash as Hash, bodyCph };
        const itemStatus = respEnc.writeStruct(pullItemCodec, item);
        if (itemStatus !== Status.Success) return itemStatus;
      }
    }
    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(pullItemCodec);
  },
};
