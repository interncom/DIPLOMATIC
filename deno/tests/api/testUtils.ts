import { Clock } from "../../../shared/clock.ts";
import type { IAuthTimestamp } from "../../../shared/codecs/authTimestamp.ts";
import { Status } from "../../../shared/consts.ts";
import {
  ICrypto,
  IProtoHost,
  IPushNotifier,
  IPushOpenResponse,
  IStorage,
  nullSubMeta,
  PublicKey,
  PushReceiver,
} from "../../../shared/types.ts";
import { ok } from "../../../shared/valstat.ts";

// Base mock storage - can be overridden per test
export const baseMockStorage: IStorage = {
  hasUser: async () => ok(true),
  addUser: async () => ok(undefined),
  subMeta: async () => ok(nullSubMeta),
  getBody: async () => ok(undefined),
  listHeads: async (_pubKey, _minSeq) => ok([]),
  setBag: async () => ok(1),
};

// Base mock crypto
export const baseMockCrypto = {
  checkSigEd25519: (
    _sig: Uint8Array,
    _message: Uint8Array | string,
    _pubKey: PublicKey,
  ) => Promise.resolve(true),
  sha256Hash: () => Promise.resolve(new Uint8Array(32)),
  blake3: () => Promise.resolve(new Uint8Array(32)),
};

// Base mock notifier
export const baseMockNotifier: IPushNotifier = {
  open: async (
    _authTS: IAuthTimestamp,
    _recv: PushReceiver,
    _crypto: ICrypto,
    _clock: Clock,
  ): Promise<IPushOpenResponse> =>
    Promise.resolve({
      send: () => Status.Success,
      shut: () => Status.Success,
      status: Status.Success,
    }),
  push: (_pubKey: PublicKey, _data: Uint8Array) => void 0,
};

// Base mock clock - synchronized for tests
export const baseMockClock = { now: () => new Date(946713599000 + 1000) };
export const mockClockForPush = { now: () => new Date(1640995200000) };

// Function to create a mock host with optional overrides
export function createMockHost(overrides: Partial<IProtoHost> = {}) {
  const mockHost = {
    storage: baseMockStorage,
    crypto: baseMockCrypto,
    notifier: baseMockNotifier,
    clock: baseMockClock,
    ...overrides,
  };
  return mockHost;
}

// Common pubKey
export const testPubKey = new Uint8Array(32).fill(0) as PublicKey;
export const testPubKeyAlt = new Uint8Array(32).fill(1) as PublicKey;

// Function to create a test IAuthTimestamp
export function createTestAuthTimestamp(
  pubKey: PublicKey = testPubKey,
  timestamp: Date = baseMockClock.now(),
): IAuthTimestamp {
  return {
    pubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp,
  };
}

// Mock clock out of sync for error tests
export const mockClockOutOfSync = { now: () => new Date(946713599000 + 40000) };

// Function to create mock host out of sync
export function createMockHostOutOfSync() {
  return createMockHost({ clock: mockClockOutOfSync });
}
