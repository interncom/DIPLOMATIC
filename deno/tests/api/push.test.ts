// push.test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { pushEnd } from "../../../shared/api/push.ts";
import { bytesEqual } from "../../../shared/binary.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { authTimestampCodec } from "../../../shared/codecs/authTimestamp.ts";
import { bagCodec } from "../../../shared/codecs/bag.ts";
import {
  IBagPushItem,
  pushItemCodec,
} from "../../../shared/codecs/pushItem.ts";
import { kdmBytes, sigBytes, Status } from "../../../shared/consts.ts";
import { IBag, IPushNotifier, PublicKey } from "../../../shared/types.ts";
import {
  baseMockCrypto,
  baseMockNotifier,
  createMockHost,
  createMockHostOutOfSync,
  createTestAuthTimestamp,
  mockClockForPush,
  testPubKey,
} from "./testUtils.ts";

Deno.test("pushEnd.handleReq - success", async () => {
  const pubKey = testPubKey;
  const tsAuth = createTestAuthTimestamp(pubKey, new Date(1640995200000));
  const bag: IBag = {
    sig: new Uint8Array(sigBytes).fill(7),
    kdm: new Uint8Array(kdmBytes).fill(10),
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, 6]),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeStruct(bagCodec, bag);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  let notified = false;
  const mockCrypto = {
    ...baseMockCrypto,
    checkSigEd25519: (
      _sig: Uint8Array,
      _message: Uint8Array | string,
      _pubKey: PublicKey,
    ) => Promise.resolve(true),
  };
  const mockNotifier: IPushNotifier = {
    ...baseMockNotifier,
    push: (pk: PublicKey, _data: Uint8Array) => {
      if (bytesEqual(pk, pubKey)) {
        notified = true;
      }
      return Promise.resolve();
    },
  };
  const mockHost = createMockHost({
    crypto: mockCrypto,
    notifier: mockNotifier,
    clock: mockClockForPush,
  });

  const status = await pushEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);
  assert(notified);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const [results, decodeStatus] = pushEnd.decodeResp(respDec);
  if (decodeStatus !== Status.Success) {
    assertEquals(decodeStatus, Status.Success);
    return;
  }
  assertEquals(results.length, 1);
  const result = results[0];
  if (result.status !== Status.Success) {
    assertEquals(result.status, Status.Success);
    return;
  }
  assertEquals(result.seq, 1);
});

Deno.test("pushEnd.handleReq - invalid signature", async () => {
  const pubKey = testPubKey;
  const tsAuth = createTestAuthTimestamp(pubKey, new Date(1640995200000));
  const bag: IBag = {
    sig: new Uint8Array(sigBytes).fill(7),
    kdm: new Uint8Array(kdmBytes).fill(10),
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, 6]),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeStruct(bagCodec, bag);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const mockCrypto = {
    ...baseMockCrypto,
    checkSigEd25519: (
      _sig: Uint8Array,
      message: Uint8Array | string,
      _pubKey: PublicKey,
    ) => Promise.resolve((message as Uint8Array).length === 6), // NOTE: this depends on the varint encoding of the tsAuth Date
  };
  const mockHost = createMockHost({
    crypto: mockCrypto,
    clock: mockClockForPush,
  });

  const status = await pushEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const [results, decodeStatus] = pushEnd.decodeResp(respDec);
  if (decodeStatus !== Status.Success) {
    assertEquals(decodeStatus, Status.Success);
    return;
  }
  assertEquals(results.length, 1);
  assertEquals(results[0].status, Status.InvalidSignature);
});

Deno.test("pushEnd.decodeResp", () => {
  const item: IBagPushItem = {
    idx: 0,
    status: Status.Success,
    seq: 0,
  };
  const enc = new Encoder();
  enc.writeStruct(pushItemCodec, item);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const [results, decodeStatus] = pushEnd.decodeResp(respDec);
  if (decodeStatus !== Status.Success) {
    assertEquals(decodeStatus, Status.Success);
    return;
  }
  assertEquals(results.length, 1);
  const result = results[0];
  if (result.status !== Status.Success) {
    assertEquals(result.status, Status.Success);
    return;
  }
  assertEquals(result.seq, 0);
});

Deno.test("pushEnd.handleReq - clock out of sync", async () => {
  const pubKey = testPubKey;
  const tsAuth = createTestAuthTimestamp(pubKey, new Date(1640995200000));
  const bag: IBag = {
    sig: new Uint8Array(sigBytes).fill(7),
    kdm: new Uint8Array(kdmBytes).fill(10),
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, 6]),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeStruct(bagCodec, bag);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const mockHostOutOfSync = createMockHostOutOfSync();

  const status = await pushEnd.handleReq(
    mockHostOutOfSync,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ClockOutOfSync);
});
