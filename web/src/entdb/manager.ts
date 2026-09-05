// Wire IEntDB / CachedEntDB to StateManager.

import { StateManager } from "../state";
import { CachedEntDB } from "./cached";
import type { IEntDB } from "./entdb";

/**
 * Build a StateManager for an EntDB.
 * When `edb` is a {@link CachedEntDB}, type notifies come from the cache
 * subscribe path (mem patch + microtask notify, then durable reconcile /
 * peer ingest). cacheDriven: StateManager.apply must not emit after the
 * applier Promise settles — that would delay UI until durable IDB.
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
