import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { hashBytes, Status } from "../../../shared/consts.ts";
import { peekEnd } from "../../../shared/api/peek.ts";
import {
  IBagPeekItem,
  peekItemCodec,
} from "../../../shared/codecs/peekItem.ts";
import { HostSpecificKeyPair, PublicKey } from "../../../shared/types.ts";

// Mock storage
const mockStorage = {
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
};

const mockClock = { now: () => new Date() };
const mockHost = { storage: mockStorage, clock: mockClock };
const pubKey = new Uint8Array([0, 1, 2, 3]) as PublicKey;

Deno.test("peekEnd.encodeReq", () => {
  const client = {}; // Mock
  const keys = {} as HostSpecificKeyPair; // Mock
  const tsAuth = new Uint8Array([10, 20, 30]);
  const body: Date[] = [new Date("2023-01-01T00:00:00.000Z")];
  const reqEnc = new Encoder();

  peekEnd.encodeReq(client as any, keys, tsAuth, body, reqEnc);

  const encoded = reqEnc.result();
  const expectedEnc = new Encoder();
  expectedEnc.writeBytes(tsAuth);
  expectedEnc.writeDate(body[0]);
  assertEquals(encoded, expectedEnc.result());
});

Deno.test("peekEnd.handleReq - success", async () => {
  const from = new Date("2023-01-01T00:00:00.000Z");
  const reqEnc = new Encoder();
  reqEnc.writeDate(from);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await peekEnd.handleReq(
    mockHost as any,
    pubKey,
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
  const from = new Date("2023-01-01T00:00:00.000Z");
  const reqEnc = new Encoder();
  reqEnc.writeDate(from);
  reqEnc.writeBytes(new Uint8Array([1])); // Extra
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);

  const respEnc = new Encoder();

  const status = await peekEnd.handleReq(
    mockHost as any,
    pubKey,
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
