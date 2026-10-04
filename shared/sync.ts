import { bagSigMsg } from "./bag.ts";
import { Decoder } from "./codec.ts";
import { IBagPeekItem } from "./codecs/peekItem.ts";
import { peekItemHeadCodec } from "./codecs/peekItemHead.ts";
import type { IKDM } from "./codecs/kdm.ts";
import { hashBytes, Status } from "./consts.ts";
import { type HostRlm, nullKDM } from "./crypto/derivation.ts";
import { Enclave } from "./crypto/enclave.ts";
import { ICrypto } from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

export interface IDecryptedBagPeekItem {
  kdm: Uint8Array;
  headEnc: Uint8Array;
}
// Opens a peek head. `rlm` is the realm the caller asked the host for.
// `realm` selects the cipher. The default realm is nullKDM.
export async function decryptPeekItem(
  item: IBagPeekItem,
  verifyKey: CryptoKey,
  enclave: Enclave,
  crypto: ICrypto,
  rlm: HostRlm,
  realm: IKDM = nullKDM,
): Promise<ValStat<IDecryptedBagPeekItem>> {
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
  const cipher = enclave.deriveCipher(kdm, "decrypt", realm);
  const [headEnc, dst] = await cipher.decrypt(headCph);
  if (dst !== Status.Success) return err(dst);
  return ok({ kdm, headEnc });
}
