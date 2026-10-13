import { type IKDM } from "../codecs/kdm.ts";
import { type MasterSeed } from "../seed.ts";
import { type ValStat } from "../valstat.ts";
import { deriveKey, type PDK, Purpose } from "./derivation.ts";

// A realm is the atomic unit of data grouping.
// Typically an app will have a single data realm.
// But there can be data realms shared across multiple apps.
// And an app may use multiple realms to enable sharing one.

// Realm key under an account key. The default realm uses nullKDM.
export async function deriveRealmKey(
  parent: MasterSeed,
  realmKDM: IKDM,
): Promise<ValStat<PDK["RealmKey"]>> {
  return deriveKey({ parent, purpose: Purpose.RealmKey, kdm: realmKDM });
}

// Stable realm id from the account key and realm KDM. No host material.
export async function deriveRealmID(
  parent: MasterSeed,
  realmKDM: IKDM,
): Promise<ValStat<PDK["RealmID"]>> {
  return deriveKey({ parent, purpose: Purpose.RealmID, kdm: realmKDM });
}

// Host-stamped bag rlm. Parent is the realm id; kdm is the host label/index.
export async function deriveHostRLM(
  parent: PDK["RealmID"],
  hostKDM: IKDM,
): Promise<ValStat<PDK["HostRLM"]>> {
  return deriveKey({ parent, purpose: Purpose.HostRLM, kdm: hostKDM });
}
