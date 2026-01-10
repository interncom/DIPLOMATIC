import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { hashBytes, Status } from "../../../shared/consts.ts";
import { peekEnd } from "../../../shared/api/peek.ts";
import {
  IBagPeekItem,
  peekItemCodec,
} from "../../../shared/codecs/peekItem.ts";
import {
  authTimestampCodec,
  type IAuthTimestamp,
} from "../../../shared/codecs/authTimestamp.ts";
import {
  HostSpecificKeyPair,
  IPushNotifier,
  PublicKey,
} from "../../../shared/types.ts";

// Mock storage
const mockStorage = {
  hasUser: () => Promise.resolve(true),
  addUser: () => Promise.resolve(),
  getBody: () => Promise.resolve(undefined as Uint8Array | undefined),
  listHeads: (
    pubKey: PublicKey,
    begin: string,
    end: string,
  ): Promise<IBagPeekItem[]> => {
    // Mock: return some items
    return Promise.resolve([
      {
        hash: new Uint8Array(hashBytes).fill(1),
        recordedAt: new Date(),
        headCph: new Uint8Array([1, 2, 3]),
      },
    ]);
  },
  setBag: () => Promise.resolve(),
};

const mockCrypto = {
  checkSigEd25519: () => Promise.resolve(true),
  sha256Hash: () => Promise.resolve(new Uint8Array(32)),
  blake3: () => Promise.resolve(new Uint8Array(32)),
};

const mockNotifier: IPushNotifier = {
  open: (authTS: IAuthTimestamp, recv: (data: Uint8Array) => void) => ({
    send: () => Status.Success,
    shut: () => Status.Success,
    status: Status.Success,
  }),
  push: (pubKey: PublicKey, data: Uint8Array) => Promise.resolve(),
};
const mockClock = { now: () => new Date(946713599000 + 1000) };
const mockHost = {
  storage: mockStorage,
  clock: mockClock,
  crypto: mockCrypto,
  notifier: mockNotifier,
};
const pubKey = new Uint8Array(32).fill(0) as PublicKey;

Deno.test("peekEnd.encodeReq", () => {
  const client = {}; // Mock
  const keys = {} as HostSpecificKeyPair; // Mock
  const tsAuth: IAuthTimestamp = {
    pubKey: new Uint8Array(32).fill(1) as PublicKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date("2023-01-01T00:00:00.000Z"),
  };
  const body: Date[] = [new Date("2023-01-01T00:00:00.000Z")];
  const reqEnc = new Encoder();

  peekEnd.encodeReq(client as any, keys, tsAuth, body, reqEnc);

  const encoded = reqEnc.result();
  const expectedEnc = new Encoder();
  expectedEnc.writeStruct(authTimestampCodec, tsAuth);
  expectedEnc.writeDate(body[0]);
  assertEquals(encoded, expectedEnc.result());
});

Deno.test("peekEnd.handleReq - success", async () => {
  const tsAuth: IAuthTimestamp = {
    pubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date(946713599000),
  };
  const from = new Date("2023-01-01T00:00:00.000Z");
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeDate(from);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await peekEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const results = Array.from(peekEnd.decodeResp(respDec));
  assertEquals(results.length, 1);
  assertEquals(results[0].hash, new Uint8Array(hashBytes).fill(1));
});

Deno.test("peekEnd.handleReq - extra body content", async () => {
  const tsAuth: IAuthTimestamp = {
    pubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date(946713599000),
  };
  const from = new Date("2023-01-01T00:00:00.000Z");
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeDate(from);
  reqEnc.writeBytes(new Uint8Array([1])); // Extra
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await peekEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ExtraBodyContent);
});

Deno.test("peekEnd.decodeResp", () => {
  const item: IBagPeekItem = {
    hash: new Uint8Array(hashBytes).fill(1),
    recordedAt: new Date(),
    headCph: new Uint8Array([1, 2, 3]),
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemCodec, item);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const results = Array.from(peekEnd.decodeResp(respDec));
  assertEquals(results.length, 1);
  assertEquals(results[0].hash, new Uint8Array(hashBytes).fill(1));
});

Deno.test("peekEnd.handleReq - clock out of sync", async () => {
  const tsAuth: IAuthTimestamp = {
    pubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date(946713599000),
  };
  const from = new Date("2023-01-01T00:00:00.000Z");
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeDate(from);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  // Mock with clock far from timestamp
  const mockClockOutOfSync = { now: () => new Date(946713599000 + 40000) }; // > 30000ms diff
  const mockHostOutOfSync = { ...mockHost, clock: mockClockOutOfSync };

  const status = await peekEnd.handleReq(
    mockHostOutOfSync,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ClockOutOfSync);
});
