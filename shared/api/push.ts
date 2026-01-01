import { bagSigValid, sealBag } from "../bag.ts";
import { Encoder } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { bagCodec } from "../codecs/bag.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IMessage } from "../message.ts";
import { type IBagPushItem, pushItemCodec } from "../codecs/pushItem.ts";

export const pushEnd: IAuthenticatedEndpoint<IMessage> = {
  async encodeReq(tsAuth, msgs, keys, crypto, enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const msg of msgs) {
      const bag = await sealBag(msg, keys, crypto, enclave);
      enc.writeStruct(bagCodec, bag);
    }

    return enc;
  },
  async handleReq(pubKey, dec, _hostID, storage, crypto, notifier) {
    const now = new Date();
    try {
      const enc = new Encoder();
      for (const bag of dec.readStructs(bagCodec)) {
        const hash = await crypto.sha256Hash(bag.headCph);
        const sigValid = await bagSigValid(bag, pubKey, crypto);
        if (!sigValid) {
          const item: IBagPushItem = {
            status: Status.InvalidSignature,
            hash,
          };
          enc.writeStruct(pushItemCodec, item);
          continue;
        }
        await storage.setBag(pubKey, now, bag, hash);
        await notifier.notify(pubKey);
        const item: IBagPushItem = { status: Status.Success, hash };
        enc.writeStruct(pushItemCodec, item);
      }
      return enc;
    } catch {
      return Status.InternalError;
    }
  },
};
