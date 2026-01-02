import { bagSigValid, sealBag } from "../bag.ts";
import { Encoder } from "../codec.ts";
import { Status } from "../consts.ts";
import { bagCodec } from "../codecs/bag.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IMessage } from "../message.ts";
import { type IBagPushItem, pushItemCodec } from "../codecs/pushItem.ts";

export const pushEnd: IAuthenticatedEndpoint<
  IMessage,
  IterableIterator<IBagPushItem>
> = {
  async encodeReq(client, keys, tsAuth, msgs) {
    const { crypto, enclave } = client;
    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const msg of msgs) {
      const bag = await sealBag(msg, keys, crypto, enclave);
      enc.writeStruct(bagCodec, bag);
    }

    return enc;
  },
  requiresRegisteredUser: true,
  async handleReq(host, pubKey, dec) {
    const { crypto, storage, notifier } = host;
    const now = new Date();
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
  },
  decodeResp(dec) {
    return dec.readStructs(pushItemCodec);
  },
};
