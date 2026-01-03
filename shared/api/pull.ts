import { hashBytes, Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { type IBagPullItem, pullItemCodec } from "../codecs/pullItem.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";

type BagHash = Uint8Array;
export const pullEnd: IAuthenticatedEndpoint<
  BagHash,
  IterableIterator<IBagPullItem>
> = {
  requiresRegisteredUser: true,
  async encodeReq(_client, _keys, authTS, hashes, reqEnc) {
    reqEnc.writeStruct(authTimestampCodec, authTS);
    reqEnc.writeBytesSeq(hashes);
  },
  async handleReq(host, pubKey, reqDec, respEnc) {
    const { storage } = host;
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
