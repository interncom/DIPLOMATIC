// Public exports for module.

import { SyncClient } from "./client";
import crypto from "./crypto";
import {
  CachedEntDB,
  type CachedEntDBOptions,
  openEntDB,
  type OpenEntDBOptions,
} from "./entdb/cached";
import {
  EntitiesQuery,
  entStateManager,
  IEntDB,
  IEntity,
  nullEntDB,
  revFromEntity,
  revFromHead,
} from "./entdb/entdb";
import { EntIDB } from "./entdb/idb";
import { EntDBMemory, type EntDBMemoryOptions } from "./entdb/memory";
import {
  useClient,
  useClientState,
  useClientXferState,
  useSyncOnResume,
} from "./react/useClient";
import useStateWatcher, {
  useStateWatcherSuspense,
} from "./react/useStateWatcher";
import { b64tob, btob64, btoh, htob } from "./shared/binary";
import { Clock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { eidCodec, genSingletonEID } from "./shared/codecs/eid";
import { Status } from "./shared/consts";
import { hostHTTPTransport, HTTPTransport } from "./shared/http";
import { TypedEventEmitter } from "./shared/events";
import {
  EntityID,
  GroupID,
  HostHandle,
  ICrypto,
  IDeleteParams,
  IEntRev,
  IHostConnectionInfo,
  IMessage,
  IMutateOp,
  type IOp,
  IStateManager,
  ITransport,
  IUpdateParams,
  MasterSeed,
} from "./shared/types";
import { nullStateManager, StateManager } from "./state";
import { IDBStore, openIDBStore } from "./stores/idb/store";
import { MemoryStore } from "./stores/memory/store";
import { SingletonStateManager } from "./shared/singleton";
import type {
  ApldState,
  Applier,
  IClient,
  IDiplomaticClientState,
  IHostRow,
  IStore,
  IStoredMessage,
  IStoredMessageData,
  IStoredMessageWrite,
} from "./types";
import {
  APLD_APPLIED,
  APLD_ERROR,
  APLD_PENDING,
  apldFromStored,
  isApldState,
  isPendingApply,
  isTerminalApplyFailure,
  setApld,
} from "./types";
import type { SyncProgressEvent } from "./progress";
import {
  defaultPeekProgressEvery,
  idleProgress,
  shouldEmitItemProgress,
} from "./progress";
import {
  openDiplomaticClient,
  type OpenDiplomaticClientMainOptions,
  type OpenDiplomaticClientOptions,
  type OpenDiplomaticClientWorkerOptions,
  type OpenedDiplomaticClient,
} from "./openClient";
import { WorkerClient } from "./worker/client";
import type { WorkerClientOptions } from "./worker/client";

export async function genWebClient(
  stateMgr: IStateManager,
  url: URL,
): Promise<
  { client: SyncClient<URL>; setSeed: (seedHex: string) => Promise<void> }
> {
  const idbStore = await openIDBStore(crypto);
  const client = new SyncClient<URL>(
    new Clock(),
    stateMgr,
    idbStore,
    hostHTTPTransport,
    crypto,
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
  APLD_APPLIED,
  APLD_ERROR,
  APLD_PENDING,
  apldFromStored,
  b64tob,
  btob64,
  btoh,
  CachedEntDB,
  Clock,
  crypto,
  Decoder,
  defaultPeekProgressEvery,
  eidCodec,
  Encoder,
  EntDBMemory,
  EntIDB,
  EntitiesQuery,
  EntityID,
  entStateManager,
  genSingletonEID,
  GroupID,
  hostHTTPTransport,
  htob,
  HTTPTransport,
  IDBStore,
  idleProgress,
  IEntDB,
  IEntity,
  isApldState,
  isPendingApply,
  isTerminalApplyFailure,
  IStore,
  MasterSeed,
  MemoryStore,
  nullEntDB,
  nullStateManager,
  openDiplomaticClient,
  openEntDB,
  openIDBStore,
  revFromEntity,
  revFromHead,
  setApld,
  shouldEmitItemProgress,
  SingletonStateManager,
  StateManager,
  Status,
  SyncClient,
  TypedEventEmitter,
  useClient,
  useClientState,
  useClientXferState,
  useStateWatcher,
  useStateWatcherSuspense,
  useSyncOnResume,
  WorkerClient,
};

export type {
  ApldState,
  Applier,
  CachedEntDBOptions,
  EntDBMemoryOptions,
  HostHandle,
  IClient,
  ICrypto,
  IDeleteParams,
  IDiplomaticClientState,
  IEntRev,
  IHostConnectionInfo,
  IHostRow,
  IMessage,
  IMutateOp,
  IOp,
  IStateManager,
  IStoredMessage,
  IStoredMessageData,
  IStoredMessageWrite,
  ITransport,
  IUpdateParams,
  OpenDiplomaticClientMainOptions,
  OpenDiplomaticClientOptions,
  OpenDiplomaticClientWorkerOptions,
  OpenedDiplomaticClient,
  OpenEntDBOptions,
  SyncProgressEvent,
  WorkerClientOptions,
};
