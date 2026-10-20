import { bagSigMsg } from "./bag.ts";
import { Decoder } from "./codec.ts";
import { IBagPeekItem } from "./codecs/peekItem.ts";
import { peekItemHeadCodec } from "./codecs/peekItemHead.ts";
import { hashBytes, Status } from "./consts.ts";
import { BagManager } from "./crypto/bagman.ts";
import { ICrypto } from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

export interface IDecryptedBagPeekItem {
  kdm: Uint8Array;
  headEnc: Uint8Array;
}
// Opens a peek head with this realm's manager.
export async function decryptPeekItem(
  item: IBagPeekItem,
  verifyKey: CryptoKey,
  bagMgr: BagManager,
  crypto: ICrypto,
): Promise<ValStat<IDecryptedBagPeekItem>> {
  const rlm = bagMgr.rlm;
  if (rlm.byteLength !== hashBytes) return err(Status.InvalidParam);
  const dec = new Decoder(item.headCph);
  const [peekItem, readStatus] = dec.readStruct(peekItemHeadCodec);
  if (readStatus !== Status.Success) {
    return err(readStatus);
  }
  const { sig, kdm, headCph } = peekItem;
  const valid = await crypto.checkSigEd25519(
    sig,
    bagSigMsg(rlm, headCph),
    verifyKey,
  );
  if (!valid) {
    return err(Status.InvalidSignature);
  }
  const [headEnc, dst] = await bagMgr.decrypt(kdm, headCph);
  if (dst !== Status.Success) return err(dst);
  return ok({ kdm, headEnc });
}
