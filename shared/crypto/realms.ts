import { IKDM } from "../codecs/kdm"
import { MasterSeed } from "../seed"
import { ValStat } from "../valstat"
import { ChildKey, deriveKey, Purpose } from "./derivation"

export type AccountKey = ChildKey<typeof Purpose.AccountKey>;
export type AppKey = ChildKey<typeof Purpose.AppKey>;
export type RealmKey = ChildKey<typeof Purpose.RealmKey>;
export type RealmID = ChildKey<typeof Purpose.RealmID>;

// An account key controls data across apps.
// You can use it to distinguish e.g. personal and work data.
// Accounts can span multiple apps, allowing data sharing.
export async function deriveAcctKey(parent: MasterSeed, acctKDM: IKDM): Promise<ValStat<AccountKey>> {
  return deriveKey({ parent, purpose: Purpose.AccountKey, kdm: acctKDM });
}

// An app key controls data for a single app, across devices.
export async function deriveAppKey(parent: AppKey, appKDM: IKDM): Promise<ValStat<AppKey>> {
  return deriveKey({ parent, purpose: Purpose.AppKey, kdm: appKDM });
}

// A realm is the atomic unit of data grouping.
// Typically an app will have a single data realm.
// But there can be data realms shared across multiple apps.
// And an app may use multiple realms to enable sharing one.
export async function deriveRealmKey(parent: AppKey | AccountKey, realmKDM: IKDM): Promise<ValStat<RealmKey>> {
  return deriveKey({ parent, purpose: Purpose.RealmKey, kdm: realmKDM });
}

export async function deriveRealmID(parent: RealmKey, hostKDM: IKDM): Promise<ValStat<RealmID>> {
  return deriveKey({ parent, purpose: Purpose.RealmID, kdm: hostKDM });
}
