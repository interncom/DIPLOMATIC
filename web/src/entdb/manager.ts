// Wire IEntDB / CachedEntDB to StateManager.

import { StateManager } from "../state";
import { CachedEntDB } from "./cached";
import type { IEntDB } from "./entdb";

/**
 * Build a StateManager for an EntDB.
 * When `edb` is a {@link CachedEntDB}, type notifies come from the cache
 * (immediate apply + durable reconcile / peer ingest).
 */
export function entStateManager(edb: IEntDB): StateManager {
  if (edb instanceof CachedEntDB) {
    const sm = new StateManager(
      (ops) => edb.apply(ops),
      () => edb.clear(),
      undefined,
      {
        cacheDriven: true,
        peerIngest: async (eids) => {
          await edb.ingestFromDurable(eids);
        },
      },
    );
    edb.subscribe((types) => sm.notify(types));
    return sm;
  }
  return new StateManager(
    (ops) => edb.apply(ops),
    () => edb.clear(),
  );
}
