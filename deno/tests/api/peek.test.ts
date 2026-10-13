import type { Identity } from "../../../shared/crypto/enclave.ts";
import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { peekEnd } from "../../../shared/api/peek.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { authTimestampCodec } from "../../../shared/codecs/authTimestamp.ts";
import {
  IBagPeekItem,
  peekItemCodec,
} from "../../../shared/codecs/peekItem.ts";
import { Status } from "../../../shared/consts.ts";
import { asHostRlm } from "../../../shared/crypto/derivation.ts";
import { IStorage, PublicKey } from "../../../shared/types.ts";
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
    _pubKey: PublicKey,
    _rlm: Uint8Array,
    _minSeq: number,
  ): Promise<ValStat<IBagPeekItem[]>> => {
    // Mock: return some items
    return ok([
      {
        headCph: new Uint8Array([1, 2, 3]),
        seq: 1,
      },
    ]);
  },
};

const mockHost = createMockHost({ storage: mockStorage });

Deno.test("peekEnd.encodeReq", () => {
  // deno-lint-ignore no-explicit-any
  const client = {} as any; // Mock
  const keys = {} as Identity; // Mock
  const tsAuth = createTestAuthTimestamp(
    new Uint8Array(32).fill(1) as PublicKey,
    new Date("2023-01-01T00:00:00.000Z"),
  );
  const [rlm, rlmSt] = asHostRlm(new Uint8Array(32).fill(9));
  if (rlmSt !== Status.Success) throw new Error(`rlm ${rlmSt}`);
  const cur = { rlm, seq: 0 };
  const reqEnc = new Encoder();

  peekEnd.encodeReq(client, keys, tsAuth, cur, reqEnc);

  const encoded = reqEnc.result();
  const expectedEnc = new Encoder();
  expectedEnc.writeStruct(authTimestampCodec, tsAuth);
  expectedEnc.writeBytes(rlm);
  expectedEnc.writeVarInt(0);
  assertEquals(encoded, expectedEnc.result());
});

Deno.test("peekEnd.handleReq - success", async () => {
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(946713599000));
  const minSeq = 0;
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeBytes(new Uint8Array(32));
  reqEnc.writeVarInt(minSeq);
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
    (results as IBagPeekItem[])[0].seq,
    1,
  );
});

Deno.test("peekEnd.handleReq - extra body content", async () => {
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(946713599000));
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeBytes(new Uint8Array(32));
  reqEnc.writeVarInt(0);
  reqEnc.writeBytes(new Uint8Array([1]));
  const reqDec = new Decoder(reqEnc.result());
  const status = await peekEnd.handleReq(mockHost, reqDec, new Encoder());
  assertEquals(status, Status.ExtraBodyContent);
});

Deno.test("peekEnd.handleReq - short body", async () => {
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
  assertEquals(status, Status.OutOfBounds);
});

Deno.test("peekEnd.decodeResp", () => {
  const item: IBagPeekItem = {
    headCph: new Uint8Array([1, 2, 3]),
    seq: 1,
  };
  const enc = new Encoder();
  enc.writeStruct(peekItemCodec, item);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const [results, decodeStatus] = peekEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  assertEquals((results as IBagPeekItem[]).length, 1);
  assertEquals(
    (results as IBagPeekItem[])[0].seq,
    1,
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
