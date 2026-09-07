// Wire IEntDB / CachedEntDB to StateManager.

import { StateManager } from "../state";
import type { CachedEntDB } from "./cached";
import type { IEntDB } from "./entdb";

/** CachedEntDB exposes subscribe; durable-only EntDB does not. */
function hasCacheSubscribe(edb: IEntDB): edb is CachedEntDB {
  return "subscribe" in edb;
}

/**
 * Build a StateManager for an EntDB.
 * When `edb` is a {@link CachedEntDB}, type notifies come from the cache
 * subscribe path (mem patch + notify after paint, then durable persist).
 * cacheDriven: StateManager.apply must not emit after the applier Promise
 * settles — that emit would wait until durable IDB.
 */
export function entStateManager(edb: IEntDB): StateManager {
  // Duck-type: `instanceof CachedEntDB` fails across duplicate module copies
  // (Vite prebundle vs alias) and would fall through to notify-after-IDB.
  if (hasCacheSubscribe(edb)) {
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
