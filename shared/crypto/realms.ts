import { IKDM } from "../codecs/kdm";
import { MasterSeed } from "../seed";
import { ValStat } from "../valstat";
import { deriveKey, PDK, Purpose } from "./derivation";

// An account key controls data across apps.
// You can use it to distinguish e.g. personal and work data.
// Accounts can span multiple apps, allowing data sharing.
export async function deriveAcctKey(
  parent: MasterSeed,
  acctKDM: IKDM,
): Promise<ValStat<PDK["AccountKey"]>> {
  return deriveKey({ parent, purpose: Purpose.AccountKey, kdm: acctKDM });
}

// An app key controls data for a single app, across devices.
export async function deriveAppKey(
  parent: PDK["AppKey"],
  appKDM: IKDM,
): Promise<ValStat<PDK["AppKey"]>> {
  return deriveKey({ parent, purpose: Purpose.AppKey, kdm: appKDM });
}

// A realm is the atomic unit of data grouping.
// Typically an app will have a single data realm.
// But there can be data realms shared across multiple apps.
// And an app may use multiple realms to enable sharing one.
export async function deriveRealmKey(
  parent: PDK["AppKey"] | PDK["AccountKey"],
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
