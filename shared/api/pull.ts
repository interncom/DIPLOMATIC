import { Encoder } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { type IBagPullItem, pullItemCodec } from "../codecs/pullItem.ts";

type BagHash = Uint8Array;
export const pullEnd: IAuthenticatedEndpoint<BagHash> = {
  async encodeReq(tsAuth, hashes, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    enc.writeBytesSeq(hashes);
    return enc;
  },
  async handleReq(pubKey, dec, _hostID, storage, _crypto, _notifier) {
    try {
      const enc = new Encoder();
      for (const headHash of dec.readBytesSeq(hashBytes)) {
        const bodyCph = await storage.getBody(pubKey, headHash);
        if (bodyCph) {
          const item: IBagPullItem = { hash: headHash, bodyCph };
          enc.writeStruct(pullItemCodec, item);
        }
      }
      return enc;
    } catch {
      return Status.InternalError;
    }
  },
};
