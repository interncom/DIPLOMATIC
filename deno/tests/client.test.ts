import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { respHeadCodec } from "../../shared/codecs/respHead.ts";
import { Status } from "../../shared/consts.ts";
import { IClock } from "../../shared/clock.ts";
import { ICrypto, IHostMetadata } from "../../shared/types.ts";
import { ok, ValStat } from "../../shared/valstat.ts";
import { Enclave } from "../../shared/enclave.ts";
// import { makeAuthTimestamp } from "../../shared/auth.ts";

const mockClock: IClock = {
  now: () => new Date("2023-01-01T00:00:00.000Z"),
};

const mockHost = {
  label: "test-host",
  handle: new URL("https://example.com"),
  idx: 0,
};

const mockEnclave = {
  derive: async () => new Uint8Array(32), // Mock derive
};
const mockCrypto = {
  blake3: async () => new Uint8Array(32),
  signEd25519: async () => new Uint8Array(64),
};

Deno.test("DiplomaticClientAPI updates host metadata on successful call", async () => {
  let capturedMeta: IHostMetadata | undefined;

  // Mock makeAuthTimestamp globally
  // deno-lint-ignore no-explicit-any
  const originalMakeAuthTimestamp = (globalThis as any).makeAuthTimestamp;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).makeAuthTimestamp =
    // deno-lint-ignore no-explicit-any
    async () => ({ sig: new Uint8Array(64), ts: new Date() } as any);

  const mockTransport = {
    call: async () => {
      // Simulate response with fake head
      const respEnc = new Encoder();
      const fakeHead = {
        status: Status.Success,
        timeRcvd: new Date("2023-01-01T00:00:01.000Z"),
        timeSent: new Date("2023-01-01T00:00:00.500Z"),
        subscription: {
          term: 1000,
          elapsed: 500,
          stat: { quota: 100, usage: 50 },
          dyn: { quota: 200, usage: 120 },
        },
      };
      respEnc.writeStruct(respHeadCodec, fakeHead);
      return ok(new Decoder(respEnc.result()));
    },
    // deno-lint-ignore no-explicit-any
    listener: {} as any,
  };

  const updateHostMeta = async (meta: IHostMetadata) => {
    capturedMeta = meta;
    return Status.Success;
  };

  const client = new DiplomaticClientAPI(
    mockEnclave as unknown as Enclave,
    mockCrypto as unknown as ICrypto,
    mockHost,
    mockClock,
    mockTransport,
    updateHostMeta,
  );

  // Mock the keys method
  client.keys = async () => ({
    pubKey: new Uint8Array(32),
    privKey: new Uint8Array(32),
    // deno-lint-ignore no-explicit-any
  } as any);

  // Mock endpoint for register
  const mockEndpoint = {
    encodeReq: async () => Status.Success,
    decodeResp: (_dec: Decoder) =>
      [undefined, Status.Success] as ValStat<undefined>,
  };

  // Call a method that triggers call
  // deno-lint-ignore no-explicit-any
  const result = await (client as any).call({
    endpoint: mockEndpoint,
    name: "register",
  }, []);

  const [, stat] = result;
  assertEquals(stat, Status.Success);
  assertEquals(capturedMeta, {
    clockOffset: 750, // calculated offset
    subscription: {
      term: 1000,
      elapsed: 500,
      stat: { quota: 100, usage: 50 },
      dyn: { quota: 200, usage: 120 },
    },
  });

  // Restore
  // deno-lint-ignore no-explicit-any
  (globalThis as any).makeAuthTimestamp = originalMakeAuthTimestamp;
});
