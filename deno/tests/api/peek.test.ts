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
  IStorage,
  PublicKey,
} from "../../../shared/types.ts";
import { ok, ValStat } from "../../../shared/valstat.ts";
import {
  baseMockStorage,
  createMockHost,
  createMockHostOutOfSync,
  createTestAuthTimestamp,
  testPubKey,
} from "./testUtils.ts";

// Mock storage with listHeads override for peek tests
const mockStorage: IStorage = {
  ...baseMockStorage,
  listHeads: async (
    pubKey: PublicKey,
    begin: string,
    end: string,
  ): Promise<ValStat<IBagPeekItem[]>> => {
    // Mock: return some items
    return ok([
      {
        hash: new Uint8Array(hashBytes).fill(1),
        recordedAt: new Date(),
        headCph: new Uint8Array([1, 2, 3]),
      },
    ]);
  },
};

const mockHost = createMockHost({ storage: mockStorage });

Deno.test("peekEnd.encodeReq", () => {
  const client = {}; // Mock
  const keys = {} as HostSpecificKeyPair; // Mock
  const tsAuth = createTestAuthTimestamp(
    new Uint8Array(32).fill(1) as PublicKey,
    new Date("2023-01-01T00:00:00.000Z"),
  );
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
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(946713599000));
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
  const [results, decodeStatus] = peekEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  assertEquals((results as IBagPeekItem[]).length, 1);
  assertEquals(
    (results as IBagPeekItem[])[0].hash,
    new Uint8Array(hashBytes).fill(1),
  );
});

Deno.test("peekEnd.handleReq - extra body content", async () => {
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(946713599000));
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

  const [results, decodeStatus] = peekEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  assertEquals((results as IBagPeekItem[]).length, 1);
  assertEquals(
    (results as IBagPeekItem[])[0].hash,
    new Uint8Array(hashBytes).fill(1),
  );
});

Deno.test("peekEnd.handleReq - clock out of sync", async () => {
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(946713599000));
  const from = new Date("2023-01-01T00:00:00.000Z");
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeDate(from);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const mockHostOutOfSync = createMockHostOutOfSync();

  const status = await peekEnd.handleReq(
    mockHostOutOfSync,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ClockOutOfSync);
});
