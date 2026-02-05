import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { peekEnd } from "../../shared/api/peek.ts";
import { makeAuthTimestamp } from "../../shared/auth.ts";
import { MockClock } from "../../shared/clock.ts";
import { Encoder } from "../../shared/codec.ts";
import { APICallName, Status } from "../../shared/consts.ts";
import { CallbackListener } from "../../shared/lpc/listener.ts";
import { CallbackNotifier } from "../../shared/lpc/pusher.ts";
import { DiplomaticLPCServer, LPCTransport } from "../../shared/lpc/server.ts";
import memStorage from "../../shared/storage/memory.ts";
import type { Hash, ICrypto, KeyPair, PublicKey } from "../../shared/types.ts";
import { baseMockClock, baseMockCrypto } from "./api/testUtils.ts";

const baseCryptoImpl: ICrypto = {
  checkSigEd25519: async (
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: PublicKey,
  ): Promise<boolean> => true, // mock
  signEd25519: async (
    message: Uint8Array | string,
    secKey: any,
  ): Promise<Uint8Array> => {
    return new Uint8Array(64).fill(0x99); // mock signature
  },
  genRandomBytes: async (bytes: number): Promise<Uint8Array> =>
    new Uint8Array(bytes).fill(0x11),
  gen256BitSecureRandomSeed: async (): Promise<Uint8Array> =>
    new Uint8Array(32).fill(0x22),
  deriveXSalsa20Poly1305Key: async (
    seed: Uint8Array,
    derivationIndex: number,
  ): Promise<Uint8Array> => new Uint8Array(32).fill(0x33),
  encryptXSalsa20Poly1305Combined: async (
    plaintext: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> => new Uint8Array(plaintext.length + 16).fill(0x44),
  decryptXSalsa20Poly1305Combined: async (
    headerAndCipher: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> => headerAndCipher.slice(16),
  deriveEd25519KeyPair: async (derivationSeed: any) => ({
    keyType: "private" as const,
    publicKey: new Uint8Array(32).fill(0x55) as PublicKey,
    privateKey: new Uint8Array(64).fill(0x66) as any,
  }),
  blake3: async (input: Uint8Array) => new Uint8Array(32).fill(0xaa) as Hash,
};

Deno.test("lpc integration", async (t) => {
  const notifier = new CallbackNotifier();

  await t.step("connect and push", async () => {
    const listener = new CallbackListener(
      notifier,
      baseMockCrypto,
      baseMockClock,
    );

    // Mock keys (for testing, dummy values)
    const publicKey = new Uint8Array(32).fill(0xab) as PublicKey;
    const privateKey = new Uint8Array(64).fill(0x42) as any;
    const keys: KeyPair = { keyType: "private", publicKey, privateKey };
    const cryptoImpl = baseCryptoImpl;
    const now = baseMockClock.now();
    const [authTS, statAuthTS] = await makeAuthTimestamp(keys, now, cryptoImpl);
    if (statAuthTS !== Status.Success) {
      assertEquals(statAuthTS, Status.Success);
      return
    }

    let receivedData: Uint8Array | undefined;
    const receiver = (data: Uint8Array) => {
      receivedData = data;
    };

    // Initially not connected
    assertEquals(listener.connected(), false);

    // Connect
    await listener.connect(authTS, receiver, () => { });
    assertEquals(listener.connected(), true);

    // Push data
    const testData = new TextEncoder().encode("TEST MESSAGE");
    notifier.push(authTS.pubKey, testData);

    // Check that data was received
    assertEquals(receivedData, testData);

    // Disconnect
    listener.disconnect();
    assertEquals(listener.connected(), false);
  });

  await t.step("multiple listeners", async () => {
    const listener1 = new CallbackListener(
      notifier,
      baseMockCrypto,
      baseMockClock,
    );
    const listener2 = new CallbackListener(
      notifier,
      baseMockCrypto,
      baseMockClock,
    );

    // Mock keys (for testing, dummy values)
    const publicKey = new Uint8Array(32).fill(0xcd) as PublicKey;
    const privateKey = new Uint8Array(64).fill(0x42) as any;
    const keys: KeyPair = { keyType: "private", publicKey, privateKey };
    const cryptoImpl = {
      ...baseCryptoImpl,
      deriveEd25519KeyPair: async (derivationSeed: any) => ({
        keyType: "private" as const,
        publicKey: new Uint8Array(32).fill(0xcd) as PublicKey,
        privateKey: new Uint8Array(64).fill(0x42) as any,
      }),
      blake3: async (input: Uint8Array) =>
        new Uint8Array(32).fill(0xaa) as Hash,
      sha256Hash: async (input: Uint8Array) => new Uint8Array(32).fill(0xbb),
      encryptXSalsa20Poly1305Combined: async (
        plaintext: Uint8Array,
        key: Uint8Array,
      ): Promise<Uint8Array> =>
        new Uint8Array(16 + plaintext.length + 16).fill(0x44),
      decryptXSalsa20Poly1305Combined: async (
        headerAndCipher: Uint8Array,
        key: Uint8Array,
      ): Promise<Uint8Array> =>
        new Uint8Array(headerAndCipher.length - 32).fill(0x55),
    };
    const now = baseMockClock.now();
    const [authTS, statAuthTS] = await makeAuthTimestamp(keys, now, cryptoImpl);
    if (statAuthTS !== Status.Success) {
      assertEquals(statAuthTS, Status.Success);
      return
    }

    let received1: Uint8Array | undefined;
    let received2: Uint8Array | undefined;

    const receiver1 = (data: Uint8Array) => {
      received1 = data;
    };
    const receiver2 = (data: Uint8Array) => {
      received2 = data;
    };

    // Connect both
    await listener1.connect(authTS, receiver1, () => { });
    await listener2.connect(authTS, receiver2, () => { });

    // Push data
    const testData = new TextEncoder().encode("MULTI TEST");
    notifier.push(authTS.pubKey, testData);

    // Both should receive
    assertEquals(received1, testData);
    assertEquals(received2, testData);

    // Disconnect one and push again
    listener1.disconnect();
    notifier.push(authTS.pubKey, new TextEncoder().encode("SECOND TEST"));

    // Only listener2 should have updated
    assertEquals(received1, testData); // Still old
    assertEquals(received2, new TextEncoder().encode("SECOND TEST"));
  });

  await t.step("invalid authTS - bad signature", async () => {
    // Custom crypto that checks sig validity
    const customCrypto: any = {
      checkSigEd25519: async (
        sig: Uint8Array,
        message: Uint8Array | string,
        pubKey: PublicKey,
      ): Promise<boolean> => sig[0] === 0x99, // mock: valid if sig[0] is 0x99
      sha256Hash: async (data: Uint8Array) => new Uint8Array(32),
      blake3: async (data: Uint8Array) => new Uint8Array(32),
    };

    const listener = new CallbackListener(
      notifier,
      customCrypto,
      baseMockClock,
    );

    // Mock keys
    const publicKey = new Uint8Array(32).fill(0xab) as PublicKey;
    const privateKey = new Uint8Array(64).fill(0x42) as any;
    const keys: KeyPair = { keyType: "private", publicKey, privateKey };
    const cryptoImpl = {
      ...baseCryptoImpl,
      blake3: async (input: Uint8Array) =>
        new Uint8Array(32).fill(0xaa) as Hash,
      sha256Hash: async (input: Uint8Array) => new Uint8Array(32).fill(0xbb),
    };
    const now = baseMockClock.now();
    const [authTS, statAuthTS] = await makeAuthTimestamp(keys, now, cryptoImpl);
    if (statAuthTS !== Status.Success) {
      assertEquals(statAuthTS, Status.Success);
      return
    }

    // Tamper with signature to make it invalid
    authTS.sig[0] ^= 1; // Flip a byte

    const status = await listener.connect(authTS, () => { }, () => { });
    assertEquals(status, Status.InvalidSignature);
    assertEquals(listener.connected(), false);
  });

  await t.step("invalid authTS - clock out of sync", async () => {
    const listener = new CallbackListener(
      notifier,
      baseMockCrypto,
      baseMockClock,
    );

    // Mock keys
    const publicKey = new Uint8Array(32).fill(0xab) as PublicKey;
    const privateKey = new Uint8Array(64).fill(0x42) as any;
    const keys: KeyPair = { keyType: "private", publicKey, privateKey };
    const cryptoImpl = baseCryptoImpl;
    // Create authTS with old timestamp
    const oldTs = new Date(Date.now() - 31000); // Beyond clockToleranceMs (30000)
    const [authTS, statAuthTS] = await makeAuthTimestamp(keys, oldTs, cryptoImpl);
    if (statAuthTS !== Status.Success) {
      assertEquals(statAuthTS, Status.Success);
      return
    }

    const status = await listener.connect(authTS, () => { }, () => { });
    assertEquals(status, Status.ClockOutOfSync);
    assertEquals(listener.connected(), false);
  });

  await t.step(
    "transport clock skew returns Status.ClockOutOfSync",
    async () => {
      // Create server with skewed clock
      const skewedClock = new MockClock(new Date(Date.now() - 60 * 60 * 1000));
      const storage = memStorage;
      const server = new DiplomaticLPCServer(
        storage,
        baseMockCrypto,
        notifier,
        skewedClock,
      );
      const transport = new LPCTransport(server);

      // Mock keys
      const publicKey = new Uint8Array(32).fill(0xab) as PublicKey;
      const privateKey = new Uint8Array(64).fill(0x42) as any;
      const keys: KeyPair = { keyType: "private", publicKey, privateKey };
      const now = baseMockClock.now(); // original time
      const [authTS, statAuthTS] = await makeAuthTimestamp(keys, now, baseCryptoImpl);
      if (statAuthTS !== Status.Success) {
        assertEquals(statAuthTS, Status.Success);
        return
      }

      // Encode request using peekEnd
      const mockClient = {
        crypto: baseCryptoImpl,
        enclave: null as any,
        clock: baseMockClock,
      };
      const items = [0]; // for peek, from date
      const reqEnc = new Encoder();
      const encStatus = await peekEnd.encodeReq(
        mockClient as any,
        keys as any,
        authTS,
        items,
        reqEnc,
      );
      assertEquals(encStatus, Status.Success);

      const [decoder, callStat] = await transport.call(
        APICallName.Peek,
        reqEnc,
      );
      assertEquals(callStat, Status.Success);
      if (!decoder) throw new Error("Decoder undefined");

      const [statusByte, readStat] = decoder.readBytes(1);
      assertEquals(readStat, Status.Success);
      assertEquals(statusByte![0], Status.ClockOutOfSync);
    },
  );
});
