import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { userEnd } from "../../../shared/api/user.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { Status } from "../../../shared/consts.ts";
import {
  HostSpecificKeyPair,
  IPushNotifier,
  PublicKey,
} from "../../../shared/types.ts";
import {
  authTimestampCodec,
  type IAuthTimestamp,
} from "../../../shared/codecs/authTimestamp.ts";

// Mock storage for testing
const mockStorage = {
  addUser: (_pubKey: PublicKey) => Promise.resolve(),
  hasUser: (_pubKey: PublicKey) => Promise.resolve(true),
  getBody: () => Promise.resolve(undefined),
  listHeads: () => Promise.resolve([]),
  setBag: () => Promise.resolve(),
};

const mockCrypto = {
  checkSigEd25519: () => Promise.resolve(true),
  sha256Hash: () => Promise.resolve(new Uint8Array(32)),
  blake3: () => Promise.resolve(new Uint8Array(32)),
};

const mockNotifier: IPushNotifier = {
  open: (_authTS: IAuthTimestamp, _recv: (data: Uint8Array) => void) => ({
    send: () => Status.Success,
    shut: () => Status.Success,
    status: Status.Success,
  }),
  push: (_pubKey: PublicKey, _data: Uint8Array) => Promise.resolve(),
};

const mockClock = { now: () => new Date(1640995200000) };

const mockHost = {
  storage: mockStorage,
  crypto: mockCrypto,
  clock: mockClock,
  notifier: mockNotifier,
};
const testPubKey = new Uint8Array(32).fill(1) as PublicKey;

Deno.test("userEnd.encodeReq", () => {
  const client = {}; // Mock, not used
  const keys = {} as HostSpecificKeyPair; // Mock, not used
  const tsAuth: IAuthTimestamp = {
    pubKey: testPubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date("2023-01-01T00:00:00.000Z"),
  };
  const body = [] as Iterable<never>;
  const reqEnc = new Encoder();

  userEnd.encodeReq(client as any, keys, tsAuth, body, reqEnc);

  const encoded = reqEnc.result();
  const expectedEnc = new Encoder();
  expectedEnc.writeStruct(authTimestampCodec, tsAuth);
  assertEquals(encoded, expectedEnc.result());
});

Deno.test("userEnd.handleReq - success", async () => {
  const tsAuth: IAuthTimestamp = {
    pubKey: testPubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date(1640995200000),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);
  const respEnc = new Encoder();

  const status = await userEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check decodeResp
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const result = userEnd.decodeResp(respDec);
  assertEquals(result, undefined);
});

Deno.test("userEnd.handleReq - extra body content", async () => {
  const tsAuth: IAuthTimestamp = {
    pubKey: testPubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date(1640995200000),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeBytes(new Uint8Array([1])); // Extra byte
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);
  const respEnc = new Encoder();

  const status = await userEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ExtraBodyContent);
});

Deno.test("userEnd.decodeResp", () => {
  const respDec = new Decoder(new Uint8Array());
  const result = userEnd.decodeResp(respDec);
  assertEquals(result, undefined);
});

Deno.test("userEnd.handleReq - clock out of sync", async () => {
  const tsAuth: IAuthTimestamp = {
    pubKey: testPubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date(1640995200000),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);
  const respEnc = new Encoder();

  // Mock with clock far from timestamp
  const mockClockOutOfSync = { now: () => new Date(1640995200000 + 40000) };
  const mockHostOutOfSync = { ...mockHost, clock: mockClockOutOfSync };

  const status = await userEnd.handleReq(
    mockHostOutOfSync,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ClockOutOfSync);
});
