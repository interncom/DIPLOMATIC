import {
  useClientState,
  useClientXferState,
  useSyncOnResume,
} from "./react/useClient";
import { opMapApplier, StateManager } from "./state";
import { localStorageStore } from "./localStorageStore";
import { idbStore } from "./idbStore";
import type { IDiplomaticClientState } from "./types";
import DiplomaticClient from "./client";
import libsodiumCrypto from "./crypto";
import { btoh, htob } from "./shared/lib";
import { type IOp, type IUpsertOp, Verb } from "./shared/types";
import useStateWatcher from "./react/useStateWatcher";
import InitSeedView from "./react/initSeedView";
import ClientStatusBar from "./react/statusBar";
import * as EntityDB from "./entityDB";

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
  opMapApplier,
  StateManager,
  useClientState,
  useClientXferState,
  useStateWatcher,
  useSyncOnResume,
  Verb,
};

export type { IDiplomaticClientState, IOp, IUpsertOp };
