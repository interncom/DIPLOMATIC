import { Decoder } from "./codec.ts";
import { IBagPeekItem } from "./codecs/peekItem.ts";
import { peekItemHeadCodec } from "./codecs/peekItemHead.ts";
import { Status } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { HostSpecificKeyPair, ICrypto } from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

export interface IDecryptedBagPeekItem {
  kdm: Uint8Array;
  headEnc: Uint8Array;
}
export async function decryptPeekItem(
  item: IBagPeekItem,
  hostKeys: HostSpecificKeyPair,
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
    hostKeys.publicKey,
  );
  if (!valid) {
    return err(Status.InvalidSignature);
  }
  const key = await enclave.deriveFromKDM(kdm);
  let headEnc: Uint8Array;
  try {
    headEnc = await crypto.decryptXSalsa20Poly1305Combined(headCph, key);
  } catch {
    // Decryption failed, skip
    return err(Status.DecryptionError);
  }
  return ok({ kdm, headEnc });
}
