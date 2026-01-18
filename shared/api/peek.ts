import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IBagPeekItem, peekItemCodec } from "../codecs/peekItem.ts";
import { authTimestampCodec, IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { validateAuthTimestamp } from "../auth.ts";

export const peekEnd: IAuthenticatedEndpoint<
  Date,
  IBagPeekItem[]
> = {
  async encodeReq(_client, _keys, authTS, body, reqEnc) {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    for (const from of body) {
      reqEnc.writeDate(from);
    }
    return Status.Success;
  },
  async handleReq(host, reqDec, respEnc) {
    const { clock, storage } = host;

    const [authTS, s] = reqDec.readStruct(authTimestampCodec);
    if (s !== Status.Success) return s;
    const validStatus = await validateAuthTimestamp(authTS as IAuthTimestamp, host.crypto, host.clock);
    if (validStatus !== Status.Success) return validStatus;
    const { pubKey } = authTS as IAuthTimestamp;

    if (!storage.hasUser(pubKey)) return Status.UserNotRegistered;

    const [from, s2] = reqDec.readDate();
    if (s2 !== Status.Success) return s2;
    if (!reqDec.done()) return Status.ExtraBodyContent;

    const begin = (from as Date).toISOString();
    const end = clock.now().toISOString();
    const items = await storage.listHeads(pubKey, begin, end);

    const s3 = respEnc.writeStructs(peekItemCodec, items);
    return s3;
  },
  decodeResp(respDec) {
    return respDec.readStructs(peekItemCodec);
  },
};
