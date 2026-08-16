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
  asSealedMasterKey,
  MASTER_SEED_LEN,
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
import { Enclave } from "./shared/crypto/enclave";
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
import {
  DEFAULT_PRF_SALT,
  prfCapable,
  type PrfRp,
} from "./shared/webauthn/prf";
import { PrfSeedStore } from "./passkey/prf-store";
import type {
  PersistPrfSeedMeta,
  PrfSeedMeta,
  PrfSeedStoreOpts,
} from "./passkey/prf-store";
import type { PasskeySeedStoreOpts } from "./passkey/seed";
import { type BundleHost } from "./shared/codecs/bundleHost";
import { asDHKEReq, asDHKEResp, PairRequest } from "./shared/crypto/pairing";
import type { DHKEReq, DHKEResp } from "./shared/crypto/pairing";
import type { PairPackagePlain } from "./shared/codecs/pairPackage";
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

/** Platform advertises largeBlob (not a guarantee the authenticator has it). */
export function largeBlobCapable(): Promise<boolean> {
  return LargeBlob.capable();
}

export { webAuthnLastError } from "./shared/webauthn/common";

export {
  APLD_APPLIED,
  APLD_ERROR,
  APLD_PENDING,
  apldFromStored,
  asDHKEReq,
  asDHKEResp,
  asSealedMasterKey,
  b64tob,
  b64urltob,
  btob64,
  btob64url,
  btoh,
  CachedEntDB,
  checksumEntRevs,
  checksumSet,
  Clock,
  cmpBytes,
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
  genSingletonEID,
  GroupID,
  hostHTTPTransport,
  htob,
  HTTPTransport,
  IDBSeedStore,
  IDBStore,
  idleProgress,
  IEntDB,
  IEntity,
  isApldState,
  isLiveEnt,
  isPendingApply,
  isTerminalApplyFailure,
  isTombstone,
  IStore,
  MASTER_SEED_LEN,
  MemoryStore,
  normalizeTags,
  nullEntDB,
  nullStateManager,
  openDiplomaticClient,
  openEntDB,
  openIDBStore,
  PairRequest,
  PasskeySeedStore,
  prfCapable,
  PrfSeedStore,
  revFromEntity,
  revFromHead,
  SEALED_MASTER_KEY_LEN,
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
  DHKEReq,
  DHKEResp,
  EntDBMemoryOptions,
  HostHandle,
  HostStatsUpdate,
  IClient,
  ICrypto,
  IDeleteParams,
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
  ListMsgsOpts,
  OpenDiplomaticClientMainOptions,
  OpenDiplomaticClientOptions,
  OpenDiplomaticClientWorkerOptions,
  OpenedDiplomaticClient,
  OpenEntDBOptions,
  PairPackagePlain,
  PasskeySeedStoreOpts,
  PersistPrfSeedMeta,
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
