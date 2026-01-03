import { bagSigValid, sealBag } from "../bag.ts";
import { Status } from "../consts.ts";
import { bagCodec } from "../codecs/bag.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IMessage } from "../message.ts";
import { type IBagPushItem, pushItemCodec } from "../codecs/pushItem.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";

export const pushEnd: IAuthenticatedEndpoint<
  IMessage,
  IterableIterator<IBagPushItem>
> = {
  requiresRegisteredUser: true,
  async encodeReq(client, keys, authTS, msgs, reqEnc) {
    const { crypto, enclave } = client;
    reqEnc.writeStruct(authTimestampCodec, authTS);

    for (const msg of msgs) {
      const bag = await sealBag(msg, keys, crypto, enclave);
      reqEnc.writeStruct(bagCodec, bag);
    }
  },
  async handleReq(host, pubKey, reqDec, respEnc) {
    const { clock, crypto, storage, notifier } = host;
    const now = clock.now();
    for (const bag of reqDec.readStructs(bagCodec)) {
      const hash = await crypto.sha256Hash(bag.headCph);
      const sigValid = await bagSigValid(bag, pubKey, crypto);
      if (!sigValid) {
        const item: IBagPushItem = {
          status: Status.InvalidSignature,
          hash,
        };
        respEnc.writeStruct(pushItemCodec, item);
        continue;
      }
      await storage.setBag(pubKey, now, bag, hash);
      await notifier.notify(pubKey);
      const item: IBagPushItem = { status: Status.Success, hash };
      respEnc.writeStruct(pushItemCodec, item);
    }
    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(pushItemCodec);
  },
};
