// Export file keys. The nonce is the KDM. Realm keys are children of the file key.

import type { IKDM } from "../codecs/kdm.ts";
import { Status } from "../consts.ts";
import { err, type ValStat } from "../valstat.ts";
import { BagManager } from "./bagman.ts";
import { deriveKey, nullKDM, type PDK, Purpose } from "./derivation.ts";
import { deriveHostRLM } from "./realms.ts";

// Bag manager for one realm in an export file. `key` is the file key.
// Does not wipe `key`.
export async function bagmanForExport(
  key: PDK["Export"],
  realmKDM: IKDM,
): Promise<ValStat<BagManager>> {
  const [idnt, ist] = await deriveKey({
    parent: key,
    purpose: Purpose.Identity,
    kdm: nullKDM,
  });
  if (ist !== Status.Success) return err(ist);
  const [realm, rst] = await deriveKey({
    parent: key,
    purpose: Purpose.RealmKey,
    kdm: realmKDM,
  });
  if (rst !== Status.Success) {
    idnt.fill(0);
    return err(rst);
  }
  const [rid, idst] = await deriveKey({
    parent: key,
    purpose: Purpose.RealmID,
    kdm: realmKDM,
  });
  if (idst !== Status.Success) {
    idnt.fill(0);
    realm.fill(0);
    return err(idst);
  }
  try {
    const [rlm, lst] = await deriveHostRLM(rid, nullKDM);
    if (lst !== Status.Success) {
      idnt.fill(0);
      realm.fill(0);
      return err(lst);
    }
    return BagManager.init(idnt, realm, rlm, nullKDM, realmKDM);
  } finally {
    rid.fill(0);
  }
}
