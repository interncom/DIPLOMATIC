import { bagSigValid, sealBag } from "../bag.ts";
import { Status } from "../consts.ts";
import { bagCodec } from "../codecs/bag.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { type IBagPushItem, pushItemCodec } from "../codecs/pushItem.ts";
import { authTimestampCodec, IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { validateAuthTimestamp } from "../auth.ts";
import { Hash, IBag, ValStat } from "../types.ts";

export const pushEnd: IAuthenticatedEndpoint<
  IBag,
  IBagPushItem[]
> = {
  async encodeReq(client, _keys, authTS, bags, reqEnc) {
    const { crypto, enclave } = client;
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    const s2 = reqEnc.writeStructs(bagCodec, bags);
    if (s2 !== Status.Success) return s2;
    return Status.Success;
  },
  async handleReq(host, reqDec, respEnc) {
    const { clock, crypto, storage, notifier } = host;
    const now = clock.now();

    const [authTS, s] = reqDec.readStruct(authTimestampCodec);
    if (s !== Status.Success) return s;
    const validStatus = await validateAuthTimestamp(authTS, host.crypto, host.clock);
    if (validStatus !== Status.Success) return validStatus;
    const { pubKey } = authTS;

    if (!storage.hasUser(pubKey)) return Status.UserNotRegistered;

    const [bags, s3] = reqDec.readStructs(bagCodec);
    if (s3 !== Status.Success) return s3;
    for (const bag of bags) {
      const hash = await crypto.sha256Hash(bag.headCph) as Hash;
      const sigValid = await bagSigValid(bag, pubKey, crypto);
      if (!sigValid) {
        const item: IBagPushItem = { status: Status.InvalidSignature, hash };
        const itemStatus = respEnc.writeStruct(pushItemCodec, item);
        if (itemStatus !== Status.Success) return itemStatus;
        continue;
      }
      await storage.setBag(pubKey, now, bag, hash);
      notifier.push(pubKey, new TextEncoder().encode("NEW OP"));
      const item: IBagPushItem = { status: Status.Success, hash };
      const itemStatus2 = respEnc.writeStruct(pushItemCodec, item);
      if (itemStatus2 !== Status.Success) return itemStatus2;
    }
    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(pushItemCodec);
  },
};
