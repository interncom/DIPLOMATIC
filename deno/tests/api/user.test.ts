import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { Decoder, Encoder } from "../../../shared/codec.ts";
import { Status } from "../../../shared/consts.ts";
import { userEnd } from "../../../shared/api/user.ts";
import { HostSpecificKeyPair, PublicKey } from "../../../shared/types.ts";

// Mock storage for testing
const mockStorage = {
  addUser: (pubKey: PublicKey) => Promise.resolve(),
};

const mockHost = { storage: mockStorage };
const pubKey = new Uint8Array([0, 1, 2, 3]) as PublicKey;

Deno.test("userEnd.encodeReq", () => {
  const client = {}; // Mock, not used
  const keys = {} as HostSpecificKeyPair; // Mock, not used
  const tsAuth = new Uint8Array([10, 20, 30]);
  const body = [] as Iterable<never>;
  const reqEnc = new Encoder();

  userEnd.encodeReq(client as any, keys, tsAuth, body, reqEnc);

  const encoded = reqEnc.result();
  assertEquals(encoded, tsAuth);
});

Deno.test("userEnd.handleReq - success", async () => {
  const reqDec = new Decoder(new Uint8Array()); // Empty
  const respEnc = new Encoder();

  const status = await userEnd.handleReq(
    mockHost as any,
    pubKey,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.Success);

  // Check decodeResp
  const respData = respEnc.result();
  const respDec = new Decoder(respData);
  const result = userEnd.decodeResp(respDec);
  assertEquals(result, undefined);
});

Deno.test("userEnd.handleReq - extra body content", async () => {
  const reqDec = new Decoder(new Uint8Array([1])); // Extra byte
  const respEnc = new Encoder();

  const status = await userEnd.handleReq(
    mockHost as any,
    pubKey,
    reqDec,
    respEnc,
  );
  assertEquals(status, Status.ExtraBodyContent);
});

Deno.test("userEnd.decodeResp", () => {
  const respDec = new Decoder(new Uint8Array());
  const result = userEnd.decodeResp(respDec);
  assertEquals(result, undefined);
});
