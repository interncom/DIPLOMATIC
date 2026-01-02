import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IBagPeekItem, peekItemCodec } from "../codecs/peekItem.ts";

export const peekEnd: IAuthenticatedEndpoint<
  Date,
  IterableIterator<IBagPeekItem>
> = {
  async encodeReq(_client, _keys, tsAuth, body, reqEnc) {
    reqEnc.writeBytes(tsAuth);
    for (const from of body) {
      reqEnc.writeDate(from);
    }
  },
  requiresRegisteredUser: true,
  async handleReq(host, pubKey, reqDec, respEnc) {
    const { storage } = host;
    const from = reqDec.readDate();
    if (!reqDec.done()) {
      return Status.ExtraBodyContent;
    }

    const begin = from.toISOString();
    const end = new Date().toISOString();
    const items = await storage.listHeads(pubKey, begin, end);

    respEnc.writeStructs(peekItemCodec, items);
    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(peekItemCodec);
  },
};
