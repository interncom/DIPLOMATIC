// push.test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { pushEnd } from "../../../shared/api/push.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { bagCodec } from "../../../shared/codecs/bag.ts";
import { pushItemCodec } from "../../../shared/codecs/pushItem.ts";
import {
  hashBytes,
  kdmBytes,
  sigBytes,
  Status,
} from "../../../shared/consts.ts";
import { IBag, PublicKey } from "../../../shared/types.ts";

Deno.test("pushEnd.handleReq - success", async () => {
  const pubKey = new Uint8Array([0, 1, 2, 3]) as PublicKey;
  const bag: IBag = {
    sig: new Uint8Array(sigBytes).fill(7),
    kdm: new Uint8Array(kdmBytes).fill(10),
    lenHeadCph: 3,
    lenBodyCph: 3,
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, 6]),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(bagCodec, bag);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  // Mocks
  let notified = false;
  const mockCrypto = {
    sha256Hash: (data: Uint8Array) =>
      Promise.resolve(new Uint8Array(hashBytes).fill(5)), // Mock 32-byte hash
    checkSigEd25519: (
      sig: Uint8Array,
      message: Uint8Array | string,
      pubKey: PublicKey,
    ) => Promise.resolve(true),
  };
  const mockStorage = {
    setBag: () => Promise.resolve(),
  };
  const mockNotifier = {
    notify: () => {
      notified = true;
      return Promise.resolve();
    },
  };
  const mockClock = { now: () => new Date() };
  const mockHost = {
    crypto: mockCrypto,
    storage: mockStorage,
    notifier: mockNotifier,
    clock: mockClock,
  };

  const status = await pushEnd.handleReq(
    mockHost as any,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);
  assert(notified);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const results = Array.from(pushEnd.decodeResp(respDec));
  assertEquals(results.length, 1);
  assertEquals(results[0].status, Status.Success);
  assertEquals(results[0].hash, new Uint8Array(hashBytes).fill(5));
});

Deno.test("pushEnd.handleReq - invalid signature", async () => {
  const pubKey = new Uint8Array([0, 1, 2, 3]) as PublicKey;
  const bag: IBag = {
    sig: new Uint8Array(sigBytes).fill(7),
    kdm: new Uint8Array(kdmBytes).fill(10),
    lenHeadCph: 3,
    lenBodyCph: 3,
    headCph: new Uint8Array([1, 2, 3]),
    bodyCph: new Uint8Array([4, 5, 6]),
  };
  const reqEnc = new Encoder();
  reqEnc.writeStruct(bagCodec, bag);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  // Mocks with invalid sig
  const mockCrypto = {
    sha256Hash: (data: Uint8Array) =>
      Promise.resolve(new Uint8Array(hashBytes).fill(5)), // Mock 32-byte hash
    checkSigEd25519: (
      sig: Uint8Array,
      message: Uint8Array | string,
      pubKey: PublicKey,
    ) => Promise.resolve(false),
  };
  const mockStorage = {
    setBag: () => Promise.resolve(),
  };
  const mockNotifier = {
    notify: () => Promise.resolve(),
  };
  const mockClock = { now: () => new Date() };
  const mockHost = {
    crypto: mockCrypto,
    storage: mockStorage,
    notifier: mockNotifier,
    clock: mockClock,
  };

  const status = await pushEnd.handleReq(
    mockHost as any,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const results = Array.from(pushEnd.decodeResp(respDec));
  assertEquals(results.length, 1);
  assertEquals(results[0].status, Status.InvalidSignature);
});

Deno.test("pushEnd.decodeResp", () => {
  const item = {
    status: Status.Success,
    hash: new Uint8Array(hashBytes).fill(1),
  };
  const enc = new Encoder();
  enc.writeStruct(pushItemCodec, item);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const results = Array.from(pushEnd.decodeResp(respDec));
  assertEquals(results.length, 1);
  assertEquals(results[0].status, Status.Success);
  assertEquals(results[0].hash, new Uint8Array(hashBytes).fill(1));
});
