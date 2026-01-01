import { Encoder } from "../codec.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { peekItemCodec } from "../codecs/peekItem.ts";

export const peekEnd: IAuthenticatedEndpoint<Date> = {
  async encodeReq(tsAuth, body, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    for (const from of body) {
      enc.writeDate(from);
    }
    return enc;
  },
  requiresRegisteredUser: true,
  async handleReq(pubKey, dec, _hostID, storage, _crypto, _notifier) {
    try {
      const from = dec.readDate();
      if (!dec.done()) {
        return Status.ExtraBodyContent;
      }

      const begin = from.toISOString();
      const end = new Date().toISOString();
      const items = await storage.listHeads(pubKey, begin, end);

      const enc = new Encoder();
      enc.writeStructs(peekItemCodec, items);
      return enc;
    } catch {
      return Status.InternalError;
    }
  },
};
