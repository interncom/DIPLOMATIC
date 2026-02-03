import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { respHeadCodec } from "../../shared/codecs/respHead.ts";
import { Status } from "../../shared/consts.ts";
import { IClock } from "../../shared/clock.ts";
import { IHostMetadata } from "../../shared/types.ts";
import { ok, ValStat } from "../../shared/valstat.ts";
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
} as any;
const mockCrypto = {
  blake3: async () => new Uint8Array(32),
  signEd25519: async () => new Uint8Array(64),
} as any;

Deno.test("DiplomaticClientAPI updates host metadata on successful call", async () => {
  let capturedMeta: IHostMetadata | undefined;

  // Mock makeAuthTimestamp globally
  const originalMakeAuthTimestamp = (globalThis as any).makeAuthTimestamp;
  (globalThis as any).makeAuthTimestamp =
    async () => ({ sig: new Uint8Array(64), ts: new Date() } as any);

  const mockTransport = {
    call: async (_name: any, _enc: Encoder) => {
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
    listener: {} as any,
  };

  const updateHostMeta = async (meta: IHostMetadata) => {
    capturedMeta = meta;
    return Status.Success;
  };

  const client = new DiplomaticClientAPI(
    mockEnclave,
    mockCrypto,
    mockHost,
    mockClock,
    mockTransport,
    updateHostMeta,
  );

  // Mock the keys method
  (client as any).keys = async () => ({
    pubKey: new Uint8Array(32),
    privKey: new Uint8Array(32),
  } as any);

  // Mock endpoint for register
  const mockEndpoint = {
    encodeReq: async () => Status.Success,
    decodeResp: (dec: Decoder) =>
      [undefined, Status.Success] as ValStat<undefined>,
  };

  // Call a method that triggers call
  const result = await (client as any).call({
    endpoint: mockEndpoint,
    name: "register",
  }, []);

  const [val, stat] = result;
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
  (globalThis as any).makeAuthTimestamp = originalMakeAuthTimestamp;
});
