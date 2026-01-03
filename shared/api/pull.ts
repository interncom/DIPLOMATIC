import { hashBytes, Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { type IBagPullItem, pullItemCodec } from "../codecs/pullItem.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { validateAuthTimestamp } from "../auth.ts";

type BagHash = Uint8Array;
export const pullEnd: IAuthenticatedEndpoint<
  BagHash,
  IterableIterator<IBagPullItem>
> = {
  async encodeReq(_client, _keys, authTS, hashes, reqEnc) {
    reqEnc.writeStruct(authTimestampCodec, authTS);
    reqEnc.writeBytesSeq(hashes);
  },
  async handleReq(host, reqDec, respEnc) {
    const { storage } = host;

    const authTS = reqDec.readStruct(authTimestampCodec);
    const status = await validateAuthTimestamp(authTS, host.crypto);
    if (status !== Status.Success) {
      return status;
    }
    const { pubKey } = authTS;

    if (!storage.hasUser(pubKey)) {
      return Status.UserNotRegistered;
    }

    for (const headHash of reqDec.readBytesSeq(hashBytes)) {
      const bodyCph = await storage.getBody(pubKey, headHash);
      if (bodyCph) {
        const item: IBagPullItem = { hash: headHash, bodyCph };
        respEnc.writeStruct(pullItemCodec, item);
      }
    }
    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(pullItemCodec);
  },
};
