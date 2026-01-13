import { SyncClient } from "./client";
import libsodiumCrypto from "./crypto";
import {
  useClientState,
  useClientXferState,
  useSyncOnResume,
} from "./react/useClient";
import useStateWatcher, {
  useStateWatcherSuspense,
} from "./react/useStateWatcher";
import { btoh, htob } from "./shared/binary";
import { type IOp } from "./shared/types";
import { StateManager } from "./state";
import { idbStore } from "./stores/idbStore";
import { localStorageStore } from "./stores/localStorageStore";
import type { IDiplomaticClientState } from "./types";

export {
  btoh,
  htob,
  idbStore,
  libsodiumCrypto,
  localStorageStore,
  StateManager, SyncClient, useClientState,
  useClientXferState,
  useStateWatcher,
  useStateWatcherSuspense,
  useSyncOnResume
};

export type { IDiplomaticClientState, IOp };
