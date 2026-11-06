// push.test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.200.0/testing/asserts.ts";
import type { BagManager } from "../../../shared/crypto/bagman.ts";
import { pushEnd, pushReqCodec } from "../../../shared/api/push.ts";
import { bytesEqual } from "../../../shared/binary.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { authTimestampCodec } from "../../../shared/codecs/authTimestamp.ts";
import { bagCodec } from "../../../shared/codecs/bag.ts";
import {
  IBagPushItem,
  pushItemCodec,
} from "../../../shared/codecs/pushItem.ts";
import { kdmBytes, sigBytes, Status } from "../../../shared/consts.ts";
import { asHostRlm, type HostRlm } from "../../../shared/crypto/derivation.ts";
import { IBag, IPushNotifier, PublicKey } from "../../../shared/types.ts";
import {
  baseMockCrypto,
  baseMockNotifier,
  baseMockStorage,
  createMockHost,
  createMockHostOutOfSync,
  createTestAuthTimestamp,
  mockClockForPush,
  testPubKey,
} from "./testUtils.ts";
import { ok } from "../../../shared/valstat.ts";

function hostRlm(fill: number): HostRlm {
  const [rlm, st] = asHostRlm(new Uint8Array(32).fill(fill));
  if (st !== Status.Success) throw new Error(`rlm ${st}`);
  return rlm;
}

Deno.test("pushEnd.encodeReq rejects a negative connID", async () => {
  // deno-lint-ignore no-explicit-any
  const client = {} as any;
  const keys = {} as BagManager;
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(1640995200000));
  const reqEnc = new Encoder();
  const status = await pushEnd.encodeReq(client, keys, tsAuth, {
    connID: -1,
    bags: [],
  }, reqEnc);
  assertEquals(status, Status.InvalidParam);
  const authOnly = new Encoder();
  authOnly.writeStruct(authTimestampCodec, tsAuth);
  assertEquals(reqEnc.result(), authOnly.result());
});

Deno.test("pushEnd.encodeReq rejects a connID longer than two bytes", async () => {
  // deno-lint-ignore no-explicit-any
  const client = {} as any;
  const keys = {} as BagManager;
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(1640995200000));
  const reqEnc = new Encoder();
  const status = await pushEnd.encodeReq(client, keys, tsAuth, {
    connID: 16384,
    bags: [],
  }, reqEnc);
  assertEquals(status, Status.VarLimitExceeded);
  const authOnly = new Encoder();
  authOnly.writeStruct(authTimestampCodec, tsAuth);
  assertEquals(reqEnc.result(), authOnly.result());
});

Deno.test("pushEnd.handleReq rejects a connID longer than two bytes", async () => {
  const pubKey = testPubKey;
  const tsAuth = createTestAuthTimestamp(pubKey, new Date(1640995200000));
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeVarInt(16384);
  const respEnc = new Encoder();
  let notified = false;
  const mockHost = createMockHost({
    clock: mockClockForPush,
    notifier: {
      ...baseMockNotifier,
      push: () => {
        notified = true;
      },
    },
  });
  const status = await pushEnd.handleReq(
    mockHost,
    new Decoder(reqEnc.result()),
    respEnc,
  );
  assertEquals(status, Status.VarLimitExceeded);
  assertEquals(notified, false);
  assertEquals(respEnc.result().byteLength, 0);

  // An overlong encoding of a small value is also past the two-byte cap.
  const wide = new Encoder();
  wide.writeStruct(authTimestampCodec, tsAuth);
  wide.writeBytes(new Uint8Array([0x81, 0x80, 0x00]));
  const wideStatus = await pushEnd.handleReq(
    mockHost,
    new Decoder(wide.result()),
    new Encoder(),
  );
  assertEquals(wideStatus, Status.VarLimitExceeded);
  assertEquals(notified, false);
});

Deno.test("pushEnd.encodeReq writes connID as a varint", async () => {
  // deno-lint-ignore no-explicit-any
  const client = {} as any;
  const keys = {} as BagManager;
  const tsAuth = createTestAuthTimestamp(testPubKey, new Date(1640995200000));
  const reqEnc = new Encoder();
  const status = await pushEnd.encodeReq(client, keys, tsAuth, {
    connID: 1,
    bags: [],
  }, reqEnc);
  assertEquals(status, Status.Success);
  const expected = new Encoder();
  expected.writeStruct(authTimestampCodec, tsAuth);
  expected.writeVarInt(1);
  assertEquals(reqEnc.result(), expected.result());

  const wide = new Encoder();
  const wideSt = await pushEnd.encodeReq(client, keys, tsAuth, {
    connID: 128,
    bags: [],
  }, wide);
  assertEquals(wideSt, Status.Success);
  const wideExp = new Encoder();
  wideExp.writeStruct(authTimestampCodec, tsAuth);
  wideExp.writeVarInt(128);
  assertEquals(wide.result(), wideExp.result());
});

Deno.test("pushEnd.handleReq - success", async () => {
  const pubKey = testPubKey;
  const tsAuth = createTestAuthTimestamp(pubKey, new Date(1640995200000));
  const bag: IBag = {
    rlm: hostRlm(3),
    sig: new Uint8Array(sigBytes).fill(7),
    kdm: new Uint8Array(kdmBytes).fill(10),
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, 6]),
  };
  const sender = 9;
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeVarInt(sender);
  reqEnc.writeStruct(bagCodec, bag);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  let notified = false;
  let gotCid: number | undefined;
  const mockCrypto = {
    ...baseMockCrypto,
    checkSigEd25519: (
      _sig: Uint8Array,
      _message: Uint8Array | string,
      _verifyKey: CryptoKey,
    ) => Promise.resolve(true),
  };
  const mockNotifier: IPushNotifier = {
    ...baseMockNotifier,
    push: (pk: PublicKey, _data: Uint8Array, connID?: number) => {
      if (bytesEqual(pk, pubKey)) {
        notified = true;
      }
      gotCid = connID;
      return Promise.resolve();
    },
  };
  const mockHost = createMockHost({
    crypto: mockCrypto,
    notifier: mockNotifier,
    clock: mockClockForPush,
  });

  const status = await pushEnd.handleReq(mockHost, reqDec, respEnc);
  assertEquals(status, Status.Success);
  assert(notified);
  assertEquals(gotCid, sender);

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
    rlm: hostRlm(3),
    sig: new Uint8Array(sigBytes).fill(7),
    kdm: new Uint8Array(kdmBytes).fill(10),
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, 6]),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeVarInt(0);
  reqEnc.writeStruct(bagCodec, bag);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const mockCrypto = {
    ...baseMockCrypto,
    checkSigEd25519: (
      _sig: Uint8Array,
      message: Uint8Array | string,
      _verifyKey: CryptoKey,
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

Deno.test("pushEnd.handleReq - blob write failure is per bag", async () => {
  const pubKey = testPubKey;
  const tsAuth = createTestAuthTimestamp(pubKey, new Date(1640995200000));
  const bags: IBag[] = [0, 1].map((n) => ({
    rlm: hostRlm(3),
    sig: new Uint8Array(sigBytes).fill(n),
    kdm: new Uint8Array(kdmBytes).fill(10),
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, n]),
  }));
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeVarInt(0);
  reqEnc.writeStruct(pushReqCodec, bags);
  const reqDec = new Decoder(reqEnc.result());
  const respEnc = new Encoder();

  let notified = 0;
  const mockHost = createMockHost({
    crypto: baseMockCrypto,
    clock: mockClockForPush,
    notifier: {
      ...baseMockNotifier,
      push: () => {
        notified += 1;
      },
    },
    storage: {
      ...baseMockStorage,
      setBags: (_pubKey, stored) => {
        if (stored.length !== 2) {
          return Promise.resolve(ok([{ status: Status.StorageError }]));
        }
        return Promise.resolve(ok([
          { status: Status.StorageError },
          { status: Status.Success, seq: 1 },
        ]));
      },
    },
  });

  const status = await pushEnd.handleReq(mockHost, reqDec, respEnc);
  assertEquals(status, Status.Success);
  assertEquals(notified, 1);

  const respDec = new Decoder(respEnc.result());
  const [results, decodeStatus] = pushEnd.decodeResp(respDec);
  assertEquals(decodeStatus, Status.Success);
  assert(results);
  assertEquals(results.length, 2);
  assertEquals(results[0].status, Status.StorageError);
  assertEquals("seq" in results[0], false);
  const stored = results[1];
  if (stored.status !== Status.Success) {
    assertEquals(stored.status, Status.Success);
    return;
  }
  assertEquals(stored.idx, 1);
  assertEquals(stored.seq, 1);
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
    rlm: hostRlm(3),
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
