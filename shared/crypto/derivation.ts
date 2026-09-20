import { Encoder } from "../codec";
import { IKDM, kdmCodec } from "../codecs/kdm";
import { Status } from "../consts";
import { err, ValStat } from "../valstat";
import { NobleCrypto } from "./noble";

type DerivationPurpose = string; // TODO: make this the union of a bunch of protocol constants.

const purposeDerivedKeySymbol = Symbol("PurposeDerivedKey");
export type PurposeDerivedKey = Uint8Array & { readonly [purposeDerivedKeySymbol]: true };

const noble = new NobleCrypto();

// derivePDK derives a "purpose-derived key" from a parent key.
export async function derivePDK(parentKey: Uint8Array, purpose: DerivationPurpose): Promise<PurposeDerivedKey> {
  const pdk = await noble.blake3(parentKey, { context: purpose });
  return pdk as Uint8Array as PurposeDerivedKey;
}

type ChildKey = Uint8Array;

// deriveChildKey derives a key from a purpose-derived key (see derivePDK).
export async function deriveChildKey(pdk: PurposeDerivedKey, kdm: IKDM): Promise<ValStat<ChildKey>> {
  const enc = new Encoder();
  const stat = kdmCodec.encode(enc, kdm);
  if (stat !== Status.Success) {
    return err(stat)
  }
  const kdmBytes = enc.result();
  const child = await noble.blake3(kdmBytes, { key: pdk });
  return [child as Uint8Array as ChildKey, Status.Success];
}
