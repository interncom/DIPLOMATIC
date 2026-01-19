import type { IAuthTimestamp } from "../../../shared/codecs/authTimestamp.ts";
import { Status } from "../../../shared/consts.ts";
import {
  IProtoHost,
  IPushNotifier,
  IPushOpenResponse,
  IStorage,
  PublicKey,
  PushReceiver,
} from "../../../shared/types.ts";

// Base mock storage - can be overridden per test
export const baseMockStorage: IStorage = {
  hasUser: async () => [true, Status.Success],
  addUser: async () => [undefined, Status.Success],
  getBody: async () => [undefined, Status.Success],
  listHeads: async () => [[], Status.Success],
  setBag: async () => [undefined, Status.Success],
};

// Base mock crypto
export const baseMockCrypto = {
  checkSigEd25519: (
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: PublicKey,
  ) => Promise.resolve(true),
  sha256Hash: () => Promise.resolve(new Uint8Array(32)),
  blake3: () => Promise.resolve(new Uint8Array(32)),
};

// Base mock notifier
export const baseMockNotifier: IPushNotifier = {
  open: async (
    _authTS: IAuthTimestamp,
    _recv: PushReceiver,
    _crypto: any,
    _clock: any,
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
