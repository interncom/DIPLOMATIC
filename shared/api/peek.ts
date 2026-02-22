import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IBagPeekItem, peekItemCodec } from "../codecs/peekItem.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { validateAuthTimestamp } from "../auth.ts";

export const peekEnd: IAuthenticatedEndpoint<
  number,
  IBagPeekItem[]
> = {
  async encodeReq(_client, _keys, authTS, body, reqEnc) {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    for (const seq of body) {
      reqEnc.writeVarInt(seq);
    }
    return Status.Success;
  },
  async handleReq(host, reqDec, respEnc) {
    const { clock, crypto, storage } = host;

    const [authTS, s] = reqDec.readStruct(authTimestampCodec);
    if (s !== Status.Success) return s;
    const validStatus = await validateAuthTimestamp(authTS, crypto, clock);
    if (validStatus !== Status.Success) return validStatus;
    const { pubKey } = authTS;

    const [hasUser, hasStatus] = await storage.hasUser(pubKey);
    if (hasStatus !== Status.Success) return hasStatus;
    if (!hasUser) return Status.UserNotRegistered;

    const [lastSeq, s2] = reqDec.readVarInt();
    if (s2 !== Status.Success) return s2;
    if (!reqDec.done()) return Status.ExtraBodyContent;

    const [items, listStatus] = await storage.listHeads(pubKey, lastSeq);
    if (listStatus !== Status.Success) return listStatus;

    const s3 = respEnc.writeStructs(peekItemCodec, items);
    return s3;
  },
  decodeResp(respDec) {
    return respDec.readStructs(peekItemCodec);
  },
};
