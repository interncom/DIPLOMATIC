import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { pullEnd } from "../../../shared/api/pull.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { pullItemCodec } from "../../../shared/codecs/pullItem.ts";
import { hashBytes, Status } from "../../../shared/consts.ts";
import { HostSpecificKeyPair, PublicKey } from "../../../shared/types.ts";
import {
  authTimestampCodec,
  type IAuthTimestamp,
} from "../../../shared/codecs/authTimestamp.ts";

// Mock storage
const mockStorage = {
  getBody: (
    pubKey: Uint8Array,
    headHash: Uint8Array,
  ): Promise<Uint8Array | null> => {
    // Mock: return some data for one hash, null for others
    if (headHash[0] === 1) {
      return Promise.resolve(new Uint8Array([10, 20, 30]));
    }
    return Promise.resolve(null);
  },
};

const mockHost = { storage: mockStorage };
const pubKey = new Uint8Array(32).fill(0) as PublicKey;

Deno.test("pullEnd.encodeReq", () => {
  const client = {}; // Mock
  const keys = {} as HostSpecificKeyPair; // Mock
  const tsAuth: IAuthTimestamp = {
    pubKey: new Uint8Array(32).fill(1) as PublicKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: new Date("2023-01-01T00:00:00.000Z"),
  };
  const hashes: Uint8Array[] = [
    new Uint8Array(hashBytes).fill(1),
    new Uint8Array(hashBytes).fill(4),
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
  reqEnc.writeBytesSeq(hashes);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await pullEnd.handleReq(
    mockHost as any,
    pubKey,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const results = Array.from(pullEnd.decodeResp(respDec));
  assertEquals(results.length, 1); // Only one hash has body
  assertEquals(results[0].hash, new Uint8Array(hashBytes).fill(1));
  assertEquals(results[0].bodyCph, new Uint8Array([10, 20, 30]));
});

Deno.test("pullEnd.handleReq - no bodies", async () => {
  const hashes: Uint8Array[] = [new Uint8Array(hashBytes).fill(0)]; // No body
  const reqEnc = new Encoder();
  reqEnc.writeBytesSeq(hashes);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await pullEnd.handleReq(
    mockHost as any,
    pubKey,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check response
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const results = Array.from(pullEnd.decodeResp(respDec));
  assertEquals(results.length, 0);
});

Deno.test("pullEnd.decodeResp", () => {
  const item = {
    hash: new Uint8Array(hashBytes).fill(1),
    bodyCph: new Uint8Array([10, 20, 30]),
  };
  const enc = new Encoder();
  enc.writeStruct(pullItemCodec, item);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const results = Array.from(pullEnd.decodeResp(respDec));
  assertEquals(results.length, 1);
  assertEquals(results[0].hash, new Uint8Array(hashBytes).fill(1));
  assertEquals(results[0].bodyCph, new Uint8Array([10, 20, 30]));
});
