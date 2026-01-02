import { Encoder } from "../codec.ts";
import { hashBytes } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { type IBagPullItem, pullItemCodec } from "../codecs/pullItem.ts";

type BagHash = Uint8Array;
export const pullEnd: IAuthenticatedEndpoint<
  BagHash,
  IterableIterator<IBagPullItem>
> = {
  async encodeReq(_client, _keys, tsAuth, hashes) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeBytesSeq(hashes);
    return enc;
  },
  requiresRegisteredUser: true,
  async handleReq(host, pubKey, dec) {
    const { storage } = host;
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
