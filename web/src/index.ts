import { useClientState, useSyncOnResume } from "./react/useClient";
import { StateManager, opMapApplier } from './state';
import { localStorageStore } from "./localStorageStore";
import { idbStore } from "./idbStore";
import type { IDiplomaticClientState } from "./types";
import DiplomaticClient from "./client";
import libsodiumCrypto from "./crypto";
import { btoh, htob } from "./shared/lib";
import { type IOp, Verb } from "./shared/types";
import useStateWatcher from "./react/useStateWatcher";
import InitSeedView from "./react/initSeedView";
import ClientStatusBar from "./react/statusBar";

export {
  useClientState,
  useSyncOnResume,
  StateManager,
  useStateWatcher,
  opMapApplier,
  localStorageStore,
  idbStore,
  DiplomaticClient,
  libsodiumCrypto,
  btoh,
  htob,
  Verb,
  InitSeedView,
  ClientStatusBar,
};

export type {
  IOp,
  IDiplomaticClientState,
};
