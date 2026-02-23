import { validateAuthTimestamp } from "../auth.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { pullItemCodec, type IBagPullItem } from "../codecs/pullItem.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const pullEnd: IAuthenticatedEndpoint<
  number,
  IBagPullItem[]
> = {
  async encodeReq(_client, _keys, authTS, seqs, reqEnc): Promise<Status> {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    for (const seq of seqs) {
      const s = reqEnc.writeVarInt(seq);
      if (s !== Status.Success) return s;
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

    const seqs: number[] = [];
    while (!reqDec.done()) {
      const [seq, s3] = reqDec.readVarInt();
      if (s3 !== Status.Success) return s3;
      seqs.push(seq);
    }
    for (const seq of seqs) {
      const [bodyCph, getStatus] = await storage.getBody(
        pubKey,
        seq,
      );
      if (getStatus !== Status.Success) return getStatus;
      if (bodyCph) {
        const item: IBagPullItem = { seq, bodyCph };
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
