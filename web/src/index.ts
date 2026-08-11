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
  IEntRow,
  isLiveEnt,
  isTombstone,
  ITombstone,
  normalizeTags,
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
import {
  b64tob,
  b64urltob,
  btob64,
  btob64url,
  btoh,
  htob,
} from "./shared/binary";
import { Clock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { eidCodec, genSingletonEID } from "./shared/codecs/eid";
import { Status } from "./shared/consts";
import { hostHTTPTransport, HTTPTransport } from "./shared/http";
import { TypedEventEmitter } from "./shared/events";
import {
  asMasterSeed,
  asSealedMasterKey,
  MASTER_SEED_LEN,
  type MasterSeed,
  SEALED_MASTER_KEY_LEN,
  type SealedMasterKey,
} from "./shared/seed";
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
} from "./shared/types";
import { Enclave, sealKeyFromPrf } from "./shared/crypto/enclave";
import { nullStateManager, StateManager } from "./state";
import { IDBSeedStore } from "./stores/idb/seed";
import { IDBStore, openIDBStore } from "./stores/idb/store";
import { MemoryStore } from "./stores/memory/store";
import { SingletonStateManager } from "./shared/singleton";
import type {
  ApldState,
  Applier,
  HostStatsUpdate,
  IClient,
  IDiplomaticClientState,
  IHostRow,
  IStore,
  IStoredMessage,
  IStoredMessageData,
  IStoredMessageWrite,
  ListMsgsOpts,
  ReconcileOpts,
  ReconcileReport,
  SetSeedOpts,
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
  defaultWebAuthnRpId,
  LargeBlob,
  PasskeySeedStore,
} from "./passkey/seed";
import type { LargeBlobCreateOpts, LargeBlobRp } from "./passkey/seed";
import {
  createPrfCred,
  DEFAULT_PRF_SALT,
  evalPrf,
  prfCapable,
  type PrfCreateOpts,
  type PrfEvalResult,
  type PrfRp,
} from "./shared/webauthn/prf";
import { PrfSeedStore } from "./passkey/prf-store";
import type {
  PersistPrfSeedMeta,
  PrfSeedMeta,
  PrfSeedStoreOpts,
} from "./passkey/prf-store";
import type { PasskeySeedStoreOpts } from "./passkey/seed";
import { type BundleHost, bundleHostCodec } from "./shared/codecs/bundleHost";
import {
  createIdentityBundle,
  IDENTITY_BUNDLE_VERSION,
  identityBundleCodec,
} from "./shared/codecs/identityBundle";
import type { IdentityBundle } from "./shared/codecs/identityBundle";
import {
  PAIR_PACKAGE_VERSION,
  PairPackage,
  pairPackageEnvelopeCodec,
  pairPackagePlainCodec,
} from "./identity/pairPackage";
import type {
  OpenedPairPackage,
  PairPackageEnvelope,
  PairPackagePlain,
} from "./identity/pairPackage";
import {
  checksumEntRevs,
  checksumSet,
  cmpBytes,
  encodeEntRev,
} from "./shared/checksum";
import {
  openDiplomaticClient,
  type OpenDiplomaticClientMainOptions,
  type OpenDiplomaticClientOptions,
  type OpenDiplomaticClientWorkerOptions,
  type OpenedDiplomaticClient,
} from "./openClient";
import { WorkerClient } from "./worker/client";
import type { WorkerClientOptions } from "./worker/client";
import type { WipeOpts } from "./types";

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
    const [enclave, st] = Enclave.fromBytes(crypto, htob(seedHex));
    if (st !== Status.Success || enclave === undefined) {
      throw new Error(`invalid seed (${st})`);
    }
    await idbStore.seed.save(enclave);
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
  asMasterSeed,
  asSealedMasterKey,
  b64tob,
  b64urltob,
  btob64,
  btob64url,
  btoh,
  bundleHostCodec,
  CachedEntDB,
  checksumEntRevs,
  checksumSet,
  Clock,
  cmpBytes,
  createIdentityBundle,
  createPrfCred,
  crypto,
  Decoder,
  DEFAULT_PRF_SALT,
  defaultPeekProgressEvery,
  defaultWebAuthnRpId,
  eidCodec,
  Enclave,
  encodeEntRev,
  Encoder,
  EntDBMemory,
  EntIDB,
  EntitiesQuery,
  EntityID,
  entStateManager,
  evalPrf,
  genSingletonEID,
  GroupID,
  hostHTTPTransport,
  htob,
  HTTPTransport,
  IDBSeedStore,
  IDBStore,
  IDENTITY_BUNDLE_VERSION,
  identityBundleCodec,
  idleProgress,
  IEntDB,
  IEntity,
  isApldState,
  isLiveEnt,
  isPendingApply,
  isTerminalApplyFailure,
  isTombstone,
  IStore,
  LargeBlob,
  MASTER_SEED_LEN,
  MasterSeed,
  MemoryStore,
  normalizeTags,
  nullEntDB,
  nullStateManager,
  openDiplomaticClient,
  openEntDB,
  openIDBStore,
  PAIR_PACKAGE_VERSION,
  PairPackage,
  pairPackageEnvelopeCodec,
  pairPackagePlainCodec,
  PasskeySeedStore,
  prfCapable,
  PrfSeedStore,
  revFromEntity,
  revFromHead,
  SEALED_MASTER_KEY_LEN,
  sealKeyFromPrf,
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
  BundleHost,
  CachedEntDBOptions,
  EntDBMemoryOptions,
  HostHandle,
  HostStatsUpdate,
  IClient,
  ICrypto,
  IDeleteParams,
  IdentityBundle,
  IDiplomaticClientState,
  IEntRev,
  IEntRow,
  IHostConnectionInfo,
  IHostRow,
  IMessage,
  IMutateOp,
  IOp,
  IStateManager,
  IStoredMessage,
  IStoredMessageData,
  IStoredMessageWrite,
  ITombstone,
  ITransport,
  IUpdateParams,
  LargeBlobCreateOpts,
  LargeBlobRp,
  ListMsgsOpts,
  OpenDiplomaticClientMainOptions,
  OpenDiplomaticClientOptions,
  OpenDiplomaticClientWorkerOptions,
  OpenedDiplomaticClient,
  OpenedPairPackage,
  OpenEntDBOptions,
  PairPackageEnvelope,
  PairPackagePlain,
  PasskeySeedStoreOpts,
  PersistPrfSeedMeta,
  PrfCreateOpts,
  PrfEvalResult,
  PrfRp,
  PrfSeedMeta,
  PrfSeedStoreOpts,
  ReconcileOpts,
  ReconcileReport,
  SealedMasterKey,
  SetSeedOpts,
  SyncProgressEvent,
  WipeOpts,
  WorkerClientOptions,
};
