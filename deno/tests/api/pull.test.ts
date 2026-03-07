import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { pullEnd } from "../../../shared/api/pull.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { authTimestampCodec } from "../../../shared/codecs/authTimestamp.ts";
import {
  IBagPullItem,
  pullItemCodec,
} from "../../../shared/codecs/pullItem.ts";
import { Status } from "../../../shared/consts.ts";
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

// Mock storage with getBody override for pull tests
const mockStorage: IStorage = {
  ...baseMockStorage,
  getBody: (
    _pubKey: Uint8Array,
    seq: number,
  ): Promise<ValStat<Uint8Array | undefined>> => {
    // Mock: return some data for seq 1, undefined for others
    if (seq === 1) {
      return Promise.resolve(ok(new Uint8Array([10, 20, 30])));
    }
    return Promise.resolve(ok(undefined));
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
  const seqs: number[] = [1, 4];
  const reqEnc = new Encoder();

  // deno-lint-ignore no-explicit-any
  pullEnd.encodeReq(client as any, keys, tsAuth, seqs, reqEnc);

  const encoded = reqEnc.result();
  const expectedEnc = new Encoder();
  expectedEnc.writeStruct(authTimestampCodec, tsAuth);
  for (const seq of seqs) {
    expectedEnc.writeVarInt(seq);
  }
  assertEquals(encoded, expectedEnc.result());
});

Deno.test("pullEnd.handleReq - success with some bodies", async () => {
  const seqs = [1, 4];
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  for (const seq of seqs) reqEnc.writeVarInt(seq);
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
  if (decodeStatus !== Status.Success) {
    assertEquals(decodeStatus, Status.Success);
    return;
  }
  assertEquals(results.length, 1); // Only one seq has body
  assertEquals(results[0].seq, 1);
  assertEquals(
    results[0].bodyCph,
    new Uint8Array([10, 20, 30]),
  );
});

Deno.test("pullEnd.handleReq - no bodies", async () => {
  const seqs: number[] = [0];
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  for (const seq of seqs) {
    reqEnc.writeVarInt(seq);
  }
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
    seq: 1,
    bodyCph: new Uint8Array([10, 20, 30]),
  };
  const enc = new Encoder();
  enc.writeStruct(pullItemCodec, item);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const [results, decodeStatus] = pullEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  if (decodeStatus !== Status.Success) return;
  assertEquals(results.length, 1);
  assertEquals(results[0].seq, 1);
  assertEquals(
    results[0].bodyCph,
    new Uint8Array([10, 20, 30]),
  );
});

Deno.test("pullEnd.handleReq - clock out of sync", async () => {
  const seqs: number[] = [1];
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  for (const seq of seqs) {
    reqEnc.writeVarInt(seq);
  }
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
