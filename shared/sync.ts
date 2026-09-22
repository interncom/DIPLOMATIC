import { Decoder } from "./codec.ts";
import { IBagPeekItem } from "./codecs/peekItem.ts";
import { peekItemHeadCodec } from "./codecs/peekItemHead.ts";
import { Status } from "./consts.ts";
import { Enclave } from "./crypto/enclave.ts";
import { ICrypto } from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

export interface IDecryptedBagPeekItem {
  kdm: Uint8Array;
  headEnc: Uint8Array;
}
export async function decryptPeekItem(
  item: IBagPeekItem,
  verifyKey: CryptoKey,
  enclave: Enclave,
  crypto: ICrypto,
): Promise<ValStat<IDecryptedBagPeekItem>> {
  const dec = new Decoder(item.headCph);
  const [peekItem, readStatus] = dec.readStruct(peekItemHeadCodec);
  if (readStatus !== Status.Success) {
    return err(readStatus);
  }
  const { sig, kdm, headCph } = peekItem;
  const valid = await crypto.checkSigEd25519(
    sig,
    headCph,
    verifyKey,
  );
  if (!valid) {
    return err(Status.InvalidSignature);
  }
  const cipher = enclave.deriveCipher(kdm, "decrypt");
  const [headEnc, dst] = await cipher.decrypt(headCph);
  if (dst !== Status.Success) return err(dst);
  return ok({ kdm, headEnc });
}
