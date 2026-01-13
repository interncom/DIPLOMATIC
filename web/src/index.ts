import {
  useClientState,
  useClientXferState,
  useSyncOnResume,
} from "./react/useClient";
import { StateManager } from "./state";
import { localStorageStore } from "./stores/localStorageStore";
import { idbStore } from "./stores/idbStore";
import type { IDiplomaticClientState } from "./types";
import DiplomaticClient from "./client";
import libsodiumCrypto from "./crypto";
import { btoh, htob } from "./shared/binary";
import { type IOp, type IUpsertOp, Verb } from "./shared/types";
import useStateWatcher, {
  useStateWatcherSuspense,
} from "./react/useStateWatcher";
import InitSeedView from "./react/initSeedView";
import ClientStatusBar from "./react/statusBar";
import * as EntityDB from "./entdb";

export {
  btoh,
  ClientStatusBar,
  DiplomaticClient,
  EntityDB,
  htob,
  idbStore,
  InitSeedView,
  libsodiumCrypto,
  localStorageStore,
  StateManager,
  useClientState,
  useClientXferState,
  useStateWatcher,
  useStateWatcherSuspense,
  useSyncOnResume,
  Verb,
};

export type { IDiplomaticClientState, IOp, IUpsertOp };
