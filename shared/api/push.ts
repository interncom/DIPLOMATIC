import { validateAuthTimestamp } from "../auth.ts";
import { bagSigValid } from "../bag.ts";
import { Encoder, ICodecStruct } from "../codec.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { bagCodec } from "../codecs/bag.ts";
import { IBagNotifItem, notifItemCodec } from "../codecs/notifItem.ts";
import { peekItemHeadCodec } from "../codecs/peekItemHead.ts";
import { type IBagPushItem, pushItemCodec } from "../codecs/pushItem.ts";
import { notifInlineBodyBytesThreshold, Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IBag } from "../types.ts";

// A PUSH request is the bags to store, each one a bagCodec.
export const pushReqCodec: ICodecStruct<IBag[]> = {
  encode(enc, bags) {
    return enc.writeStructs(bagCodec, bags);
  },
  decode(dec) {
    return dec.readStructs(bagCodec);
  },
};

// PUSH accepts a list of bags and returns a list of the same size.
// Returned list items give the status of each bag and its index in the request.
// For each successfully stored bag, the list item also includes its host seq.
export const pushEnd: IAuthenticatedEndpoint<
  IBag[],
  IBagPushItem[]
> = {
  async encodeReq(_client, _identity, authTS, bags, reqEnc) {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    return reqEnc.writeStruct(pushReqCodec, bags);
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

    const [bags, s3] = reqDec.readStruct(pushReqCodec);
    if (s3 !== Status.Success) return s3;

    console.info(`PUSH: ${bags.length} bags`);

    // One verify key for every bag in this push.
    let verifyKey: CryptoKey;
    try {
      verifyKey = await crypto.importVerifyKey(pubKey);
    } catch {
      return Status.CryptoError;
    }

    // Verify sigs first; store valid bags in one storage batch.
    const validIdx: number[] = [];
    const validBags: IBag[] = [];
    for (let idx = 0; idx < bags.length; idx++) {
      const bag = bags[idx];
      const sigValid = await bagSigValid(bag, verifyKey, crypto);
      if (!sigValid) {
        const item: IBagPushItem = { idx, status: Status.InvalidSignature };
        const itemStatus = respEnc.writeStruct(pushItemCodec, item);
        if (itemStatus !== Status.Success) return itemStatus;
        continue;
      }
      validIdx.push(idx);
      validBags.push(bag);
    }

    const [stored, setStatus] = await storage.setBags(pubKey, validBags);
    if (setStatus !== Status.Success) {
      return setStatus;
    }
    if (!stored || stored.length !== validBags.length) {
      return Status.StorageError;
    }

    const notifs: IBagNotifItem[] = [];
    for (let i = 0; i < validBags.length; i++) {
      const bag = validBags[i];
      const idx = validIdx[i];
      const result = stored[i];
      if (result.status !== Status.Success) {
        const failed: IBagPushItem = { idx, status: result.status };
        const failStatus = respEnc.writeStruct(pushItemCodec, failed);
        if (failStatus !== Status.Success) return failStatus;
        continue;
      }
      const seq = result.seq;

      const encNotifHeadCph = new Encoder();
      const statNotifHeadCph = encNotifHeadCph.writeStruct(
        peekItemHeadCodec,
        bag,
      );
      if (statNotifHeadCph !== Status.Success) return statNotifHeadCph;
      const notifHeadCph = encNotifHeadCph.result();
      const notif: IBagNotifItem = { seq, rlm: bag.rlm, headCph: notifHeadCph };
      if (
        bags.length === 1 && bag.bodyCph.length <= notifInlineBodyBytesThreshold
      ) {
        notif.bodyCph = bag.bodyCph;
      }
      notifs.push(notif);

      const item: IBagPushItem = { idx, status: Status.Success, seq };
      const itemStatus2 = respEnc.writeStruct(pushItemCodec, item);
      if (itemStatus2 !== Status.Success) return itemStatus2;
    }

    // Send notifications.
    if (notifs.length > 0) {
      const encBatch = new Encoder();
      const statBatch = encBatch.writeStructs(notifItemCodec, notifs);
      if (statBatch !== Status.Success) return statBatch;
      const batchEnc = encBatch.result();
      await Promise.resolve(notifier.push(pubKey, batchEnc));
    }

    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(pushItemCodec);
  },
};
