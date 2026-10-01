import { IKDM } from "../codecs/kdm";
import { MasterSeed } from "../seed";
import { ValStat } from "../valstat";
import { deriveKey, PDK, Purpose } from "./derivation";

// Realm key under one account. The parent is that account's key (its master seed).
// An app may use several realms. Two apps share a realm by holding the same key.
export async function deriveRealmKey(
  parent: MasterSeed,
  realmKDM: IKDM,
): Promise<ValStat<PDK["RealmKey"]>> {
  return deriveKey({ parent, purpose: Purpose.RealmKey, kdm: realmKDM });
}

export async function deriveRealmID(
  parent: PDK["RealmKey"],
  hostKDM: IKDM,
): Promise<ValStat<PDK["RealmID"]>> {
  return deriveKey({ parent, purpose: Purpose.RealmID, kdm: hostKDM });
}
