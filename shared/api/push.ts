import { sealBag } from "../bag.ts";
import { Encoder } from "../codec.ts";
import { bagCodec } from "../codecs/bag.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IMessage } from "../message.ts";

export const pushEnd: IAuthenticatedEndpoint<IMessage> = {
  async encodeReq(tsAuth, msgs, keyPair, crypto, enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);

    for (const msg of msgs) {
      const bag = await sealBag(msg, keyPair, crypto, enclave);
      enc.writeStruct(bagCodec, bag);
    }

    return enc;
  },
  // async encodeResp(items) {
  // },
};
