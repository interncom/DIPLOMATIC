import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IBagPeekItem, peekItemCodec } from "../codecs/peekItem.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";

export const peekEnd: IAuthenticatedEndpoint<
  Date,
  IterableIterator<IBagPeekItem>
> = {
  requiresRegisteredUser: true,
  async encodeReq(_client, _keys, authTS, body, reqEnc) {
    reqEnc.writeStruct(authTimestampCodec, authTS);
    for (const from of body) {
      reqEnc.writeDate(from);
    }
  },
  async handleReq(host, pubKey, reqDec, respEnc) {
    const { clock, storage } = host;
    const from = reqDec.readDate();
    if (!reqDec.done()) {
      return Status.ExtraBodyContent;
    }

    const begin = from.toISOString();
    const end = clock.now().toISOString();
    const items = await storage.listHeads(pubKey, begin, end);

    respEnc.writeStructs(peekItemCodec, items);
    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(peekItemCodec);
  },
};
