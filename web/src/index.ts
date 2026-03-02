import { SyncClient } from "./client";
import libsodiumCrypto from "./crypto";
import {
  EntitiesQuery,
  entStateManager,
  IEntDB,
  IEntity,
  nullEntDB,
} from "./entdb/entdb";
import { EntIDB } from "./entdb/idb";
import { EntDBMemory } from "./entdb/memory";
import {
  useClientState,
  useClientXferState,
  useSyncOnResume,
} from "./react/useClient";
import useStateWatcher, {
  useStateWatcherSuspense,
} from "./react/useStateWatcher";
import { btoh, htob } from "./shared/binary";
import { Clock } from "./shared/clock";
import { genSingletonEID } from "./shared/codecs/eid";
import { Status } from "./shared/consts";
import { HTTPTransport } from "./shared/http";
import { EntityID, GroupID, type IOp, MasterSeed } from "./shared/types";
import { nullStateManager, StateManager } from "./state";
import { IDBStore, openIDBStore } from "./stores/idb/store";
import { MemoryStore } from "./stores/memory/store";
import type { IDiplomaticClientState, IHostRow, IStateManager, IStore } from "./types";

export const hostHTTPTransport = (host: IHostRow<URL>) => {
  return new HTTPTransport(host.handle);
}

export async function genWebClient(
  stateMgr: StateManager,
  url: URL,
): Promise<
  { client: SyncClient<URL>; setSeed: (seedHex: string) => Promise<void> }
> {
  const idb = await openIDBStore();
  const idbStore = new IDBStore(idb, libsodiumCrypto);
  const transport = (host: IHostRow<URL>) => new HTTPTransport(host.handle);
  const client = new SyncClient<URL>(
    new Clock(),
    stateMgr,
    idbStore,
    transport,
  );
  const setSeed = async (seedHex: string) => {
    const seed = htob(seedHex) as MasterSeed;
    await idbStore.seed.save(seed);
    await idbStore.hosts.add({ handle: url, label: "host", idx: 0 });
    await client.connect();
  };
  return { client, setSeed };
}

export {
  btoh,
  Clock,
  EntDBMemory,
  EntIDB,
  EntitiesQuery,
  EntityID,
  entStateManager,
  genSingletonEID,
  GroupID,
  htob,
  HTTPTransport,
  IDBStore,
  IEntDB,
  IEntity,
  IStateManager,
  IStore,
  libsodiumCrypto,
  MasterSeed,
  MemoryStore,
  nullEntDB,
  nullStateManager,
  openIDBStore,
  StateManager,
  Status,
  SyncClient,
  useClientState,
  useClientXferState,
  useStateWatcher,
  useStateWatcherSuspense,
  useSyncOnResume,
};

export type { IDiplomaticClientState, IOp };
