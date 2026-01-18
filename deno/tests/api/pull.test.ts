import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { pullEnd } from "../../../shared/api/pull.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import {
  IBagPullItem,
  pullItemCodec,
} from "../../../shared/codecs/pullItem.ts";
import { hashBytes, Status } from "../../../shared/consts.ts";
import { Hash, HostSpecificKeyPair, PublicKey } from "../../../shared/types.ts";
import {
  authTimestampCodec,
  type IAuthTimestamp,
} from "../../../shared/codecs/authTimestamp.ts";
import {
  baseMockStorage,
  createMockHost,
  createMockHostOutOfSync,
  createTestAuthTimestamp,
  testPubKey,
} from "./testUtils.ts";

// Mock storage with getBody override for pull tests
const mockStorage = {
  ...baseMockStorage,
  getBody: (
    pubKey: Uint8Array,
    headHash: Uint8Array,
  ): Promise<Uint8Array | undefined> => {
    // Mock: return some data for one hash, undefined for others
    if (headHash[0] === 1) {
      return Promise.resolve(new Uint8Array([10, 20, 30]));
    }
    return Promise.resolve(undefined);
  },
};

const mockHost = createMockHost({ storage: mockStorage });

const tsAuth = createTestAuthTimestamp(testPubKey, new Date(946713599000));

Deno.test("pullEnd.encodeReq", () => {
  const client = {}; // Mock
  const keys = {} as HostSpecificKeyPair; // Mock
  const tsAuth = createTestAuthTimestamp(
    new Uint8Array(32).fill(1) as PublicKey,
    new Date("2023-01-01T00:00:00.000Z"),
  );
  const hashes: Hash[] = [
    new Uint8Array(hashBytes).fill(1) as Hash,
    new Uint8Array(hashBytes).fill(4) as Hash,
  ];
  const reqEnc = new Encoder();

  pullEnd.encodeReq(client as any, keys, tsAuth, hashes, reqEnc);

  const encoded = reqEnc.result();
  const expectedEnc = new Encoder();
  expectedEnc.writeStruct(authTimestampCodec, tsAuth);
  expectedEnc.writeBytesSeq(hashes);
  assertEquals(encoded, expectedEnc.result());
});

Deno.test("pullEnd.handleReq - success with some bodies", async () => {
  const hashes: Uint8Array[] = [
    new Uint8Array(hashBytes).fill(1),
    new Uint8Array(hashBytes).fill(4),
  ];
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeBytesSeq(hashes);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await pullEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const [results, decodeStatus] = pullEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  assertEquals((results as IBagPullItem[]).length, 1); // Only one hash has body
  assertEquals((results as IBagPullItem[])[0].hash, new Uint8Array(hashBytes).fill(1) as Hash);
  assertEquals((results as IBagPullItem[])[0].bodyCph, new Uint8Array([10, 20, 30]));
});

Deno.test("pullEnd.handleReq - no bodies", async () => {
  const hashes: Uint8Array[] = [new Uint8Array(hashBytes).fill(0)]; // No body
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeBytesSeq(hashes);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await pullEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const [results, decodeStatus] = pullEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  assertEquals((results as IBagPullItem[]).length, 0);
});

Deno.test("pullEnd.decodeResp", () => {
  const item: IBagPullItem = {
    hash: new Uint8Array(hashBytes).fill(1) as Hash,
    bodyCph: new Uint8Array([10, 20, 30]),
  };
  const enc = new Encoder();
  enc.writeStruct(pullItemCodec, item);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const [results, decodeStatus] = pullEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  assertEquals((results as IBagPullItem[]).length, 1);
  assertEquals((results as IBagPullItem[])[0].hash, new Uint8Array(hashBytes).fill(1) as Hash);
  assertEquals((results as IBagPullItem[])[0].bodyCph, new Uint8Array([10, 20, 30]));
});

Deno.test("pullEnd.handleReq - clock out of sync", async () => {
  const hashes: Uint8Array[] = [
    new Uint8Array(hashBytes).fill(1),
  ];
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeBytesSeq(hashes);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const mockHostOutOfSync = createMockHostOutOfSync();

  const status = await pullEnd.handleReq(
    mockHostOutOfSync,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ClockOutOfSync);
});
