import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { Status } from "../../../shared/consts.ts";
import { hostEnd } from "../../../shared/api/host.ts";
import { HostSpecificKeyPair, PublicKey } from "../../../shared/types.ts";

// Mock crypto for testing
const mockCrypto = {
  sha256Hash: (data: Uint8Array) =>
    Promise.resolve(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), // First 8 bytes for 32-byte hash slice 0-3
};

const mockHost = { crypto: mockCrypto, hostID: "test-host" };
const pubKey = new Uint8Array([0, 1, 2, 3]) as PublicKey;

Deno.test("hostEnd.encodeReq", () => {
  const client = {}; // Mock, not used in encodeReq
  const keys = {} as HostSpecificKeyPair; // Mock, not used
  const tsAuth = new Uint8Array([10, 20, 30]);
  const body = [] as Iterable<never>;
  const reqEnc = new Encoder();

  hostEnd.encodeReq(client as any, keys, tsAuth, body, reqEnc);

  const encoded = reqEnc.result();
  assertEquals(encoded, tsAuth);
});

Deno.test("hostEnd.handleReq - success", async () => {
  const reqDec = new Decoder(new Uint8Array()); // Empty decoder, as expected after tsAuth
  const respEnc = new Encoder();

  const status = await hostEnd.handleReq(
    mockHost as any,
    pubKey,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check decodeResp
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const result = hostEnd.decodeResp(respDec);

  // Expected: hostID + "-" + btoa(String.fromCharCode(...hash.slice(0,4)))
  // hash.slice(0,4) = [1,2,3,4] -> String.fromCharCode(1,2,3,4) -> "\x01\x02\x03\x04" -> btoa("AQIDBA==")
  const expected = "test-host-AQIDBA==";
  assertEquals(result, expected);
});

Deno.test("hostEnd.handleReq - extra body content", async () => {
  const reqDec = new Decoder(new Uint8Array([1])); // Extra byte
  const respEnc = new Encoder();

  const status = await hostEnd.handleReq(
    mockHost as any,
    pubKey,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ExtraBodyContent);
});

Deno.test("hostEnd.handleReq - server misconfigured", async () => {
  const badHost = { crypto: mockCrypto, hostID: null };
  const reqDec = new Decoder(new Uint8Array());
  const respEnc = new Encoder();

  const status = await hostEnd.handleReq(
    badHost as any,
    pubKey,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ServerMisconfigured);
});

Deno.test("hostEnd.decodeResp", () => {
  const uniqueID = "test-host-ABCD";
  const bytes = new TextEncoder().encode(uniqueID);
  const enc = new Encoder();
  enc.writeVarInt(bytes.length);
  enc.writeBytes(bytes);
  const respData = enc.result();
  const respDec = new Decoder(respData);

  const result = hostEnd.decodeResp(respDec);
  assertEquals(result, uniqueID);
});
