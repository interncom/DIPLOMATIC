import { useClientState, useSyncOnResume } from "./useClient";
import { StateManager, useStateWatcher, opMapApplier } from './state';
import { localStorageStore } from "./localStorageStore";
import { idbStore } from "./idbStore";
import type { IDiplomaticClientState } from "./types";
import DiplomaticClient from "./client";
import libsodiumCrypto from "./crypto";
import { btoh, htob } from "./shared/lib";
import { type IOp, Verb } from "./shared/types";

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
};

export type {
  IOp,
  IDiplomaticClientState,
};
