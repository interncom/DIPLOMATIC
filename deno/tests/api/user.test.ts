import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { userEnd } from "../../../shared/api/user.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { Status } from "../../../shared/consts.ts";
import { HostSpecificKeyPair, PublicKey } from "../../../shared/types.ts";
import {
  authTimestampCodec,
  type IAuthTimestamp,
} from "../../../shared/codecs/authTimestamp.ts";
import {
  createMockHost,
  createMockHostOutOfSync,
  createTestAuthTimestamp,
  mockClockForPush,
  testPubKeyAlt,
} from "./testUtils.ts";

const mockHost = createMockHost({ clock: mockClockForPush });

Deno.test("userEnd.encodeReq", () => {
  const client = {}; // Mock, not used
  const keys = {} as HostSpecificKeyPair; // Mock, not used
  const tsAuth = createTestAuthTimestamp(
    testPubKeyAlt,
    new Date("2023-01-01T00:00:00.000Z"),
  );
  const body = [] as Iterable<never>;
  const reqEnc = new Encoder();

  userEnd.encodeReq(client as any, keys, tsAuth, body, reqEnc);

  const encoded = reqEnc.result();
  const expectedEnc = new Encoder();
  expectedEnc.writeStruct(authTimestampCodec, tsAuth);
  assertEquals(encoded, expectedEnc.result());
});

Deno.test("userEnd.handleReq - success", async () => {
  const tsAuth = createTestAuthTimestamp(
    testPubKeyAlt,
    new Date(1640995200000),
  );
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);
  const respEnc = new Encoder();

  const status = await userEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check decodeResp
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const resp = userEnd.decodeResp(respDec);
  const [result, decodeStatus] = resp;
  assertEquals(decodeStatus, Status.Success);
  assertEquals(result, undefined);
});

Deno.test("userEnd.handleReq - extra body content", async () => {
  const tsAuth = createTestAuthTimestamp(
    testPubKeyAlt,
    new Date(1640995200000),
  );
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  reqEnc.writeBytes(new Uint8Array([1])); // Extra byte
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);
  const respEnc = new Encoder();

  const status = await userEnd.handleReq(
    mockHost,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ExtraBodyContent);
});

Deno.test("userEnd.decodeResp", () => {
  const respDec = new Decoder(new Uint8Array());
  const [val, status] = userEnd.decodeResp(respDec);
  assertEquals(status, Status.Success);
  assertEquals(val, undefined);
});

Deno.test("userEnd.handleReq - clock out of sync", async () => {
  const tsAuth = createTestAuthTimestamp(
    testPubKeyAlt,
    new Date(1640995200000),
  );
  const reqEnc = new Encoder();
  reqEnc.writeStruct(authTimestampCodec, tsAuth);
  const reqData = reqEnc.result();
  const reqDec = new Decoder(reqData);
  const respEnc = new Encoder();

  const mockHostOutOfSync = createMockHostOutOfSync();

  const status = await userEnd.handleReq(
    mockHostOutOfSync,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ClockOutOfSync);
});
