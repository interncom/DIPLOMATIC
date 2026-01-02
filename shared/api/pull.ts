import { Encoder } from "../codec.ts";
import { hashBytes } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { type IBagPullItem, pullItemCodec } from "../codecs/pullItem.ts";

type BagHash = Uint8Array;
export const pullEnd: IAuthenticatedEndpoint<
  BagHash,
  IterableIterator<IBagPullItem>
> = {
  async encodeReq(tsAuth, hashes, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeBytesSeq(hashes);
    return enc;
  },
  requiresRegisteredUser: true,
  async handleReq(pubKey, dec, _hostID, storage, _crypto, _notifier) {
    const enc = new Encoder();
    for (const headHash of dec.readBytesSeq(hashBytes)) {
      const bodyCph = await storage.getBody(pubKey, headHash);
      if (bodyCph) {
        const item: IBagPullItem = { hash: headHash, bodyCph };
        enc.writeStruct(pullItemCodec, item);
      }
    }
    return enc;
  },
  decodeResp(dec) {
    return dec.readStructs(pullItemCodec);
  },
};
