import { validateAuthTimestamp } from "../auth.ts";
import { bagSigValid } from "../bag.ts";
import { Encoder } from "../codec.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { bagCodec } from "../codecs/bag.ts";
import { IBagNotifItem, notifItemCodec } from "../codecs/notifItem.ts";
import { peekItemHeadCodec } from "../codecs/peekItemHead.ts";
import { type IBagPushItem, pushItemCodec } from "../codecs/pushItem.ts";
import { notifInlineBodyBytesThreshold, Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IBag } from "../types.ts";

// PUSH accepts a list of bags and returns a list of the same size.
// Returned list items give the status of each bag and its index in the request.
// For each successfully stored bag, the list item also includes its host seq.
export const pushEnd: IAuthenticatedEndpoint<
  IBag,
  IBagPushItem[]
> = {
  async encodeReq(client, _keys, authTS, bags, reqEnc) {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    const s2 = reqEnc.writeStructs(bagCodec, bags);
    if (s2 !== Status.Success) return s2;
    return Status.Success;
  },
  async handleReq(host, reqDec, respEnc) {
    const { clock, crypto, storage, notifier } = host;

    const [authTS, s] = reqDec.readStruct(authTimestampCodec);
    if (s !== Status.Success) return s;
    const validStatus = await validateAuthTimestamp(authTS, crypto, clock);
    if (validStatus !== Status.Success) return validStatus;
    const { pubKey } = authTS;

    const [hasUser, hasStatus] = await storage.hasUser(pubKey);
    if (hasStatus !== Status.Success) return hasStatus;
    if (!hasUser) return Status.UserNotRegistered;

    const [bags, s3] = reqDec.readStructs(bagCodec);
    if (s3 !== Status.Success) return s3;

    console.info(`PUSH: ${bags.length} bags`);

    const notifs: IBagNotifItem[] = [];

    for (let idx = 0; idx < bags.length; idx++) {
      // Check signature.
      const bag = bags[idx];
      const sigValid = await bagSigValid(bag, pubKey, crypto);
      if (!sigValid) {
        const item: IBagPushItem = { idx, status: Status.InvalidSignature };
        const itemStatus = respEnc.writeStruct(pushItemCodec, item);
        if (itemStatus !== Status.Success) return itemStatus;
        continue;
      }

      // Store bag.
      const [seq, setStatus] = await storage.setBag(pubKey, bag);
      if (setStatus !== Status.Success) {
        return setStatus;
      }

      // Prepare notification of new bag.
      const encNotifHeadCph = new Encoder();
      const statNotifHeadCph = encNotifHeadCph.writeStruct(
        peekItemHeadCodec,
        bag,
      );
      if (statNotifHeadCph !== Status.Success) return statNotifHeadCph;
      const notifHeadCph = encNotifHeadCph.result();
      const notif: IBagNotifItem = { seq, headCph: notifHeadCph };
      if (
        bags.length === 1 && bag.bodyCph.length <= notifInlineBodyBytesThreshold
      ) {
        notif.bodyCph = bag.bodyCph;
      }
      notifs.push(notif);

      // Write response item.
      const item: IBagPushItem = { idx, status: setStatus, seq };
      const itemStatus2 = respEnc.writeStruct(pushItemCodec, item);
      if (itemStatus2 !== Status.Success) return itemStatus2;
    }

    // Send notifications.
    const encBatch = new Encoder();
    const statBatch = encBatch.writeStructs(notifItemCodec, notifs);
    if (statBatch !== Status.Success) return statBatch;
    const batchEnc = encBatch.result();
    notifier.push(pubKey, batchEnc);

    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(pushItemCodec);
  },
};
