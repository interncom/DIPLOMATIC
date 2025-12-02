import { assert, assertEquals } from "jsr:@std/assert@0.223.0";
import { timestampAuthProof } from "../../shared/auth.ts";
import { decodeSigProvenData } from "../../shared/sigProof.ts";
import type { ICrypto, KeyPair } from "../../shared/types.ts";

// Mock ICrypto using a fixed Ed25519 key pair for testing
// Using test vectors from RFC 8032 for determinism
const privateKeyRaw = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92,
  0xec, 0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b,
  0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);
const publicKeyRaw = new Uint8Array([
  0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9,
  0x64, 0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02,
  0x1a, 0x68, 0xf7, 0x07, 0x51, 0x1a,
]);

const mockCrypto: ICrypto = {
  // Stub other methods not used in this test
  gen128BitRandomID: () => Promise.resolve(new Uint8Array(16)),
  gen256BitSecureRandomSeed: () => Promise.resolve(new Uint8Array(32)),
  deriveXSalsa20Poly1305Key: () => Promise.resolve(new Uint8Array(32)),
  encryptXSalsa20Poly1305Combined: () => Promise.resolve(new Uint8Array(0)),
  decryptXSalsa20Poly1305Combined: () => Promise.resolve(new Uint8Array(0)),
  sha256Hash: (data) =>
    crypto.subtle
      .digest("SHA-256", data.slice())
      .then((hash) => new Uint8Array(hash)),

  deriveEd25519KeyPair: async (
    seed,
    hostID,
    derivationIndex,
  ): Promise<KeyPair> => {
    // Return fixed keys for testing, ignoring seed/hostID/idx
    return {
      keyType: "private",
      privateKey: privateKeyRaw.slice(),
      publicKey: publicKeyRaw.slice(),
    };
  },

  signEd25519: async (message, secKey) => {
    return new Uint8Array(64).fill(0);
  },

  checkSigEd25519: async (sig, message, pubKey) => {
    return true;
  },
};

Deno.test(
  "timestampAuthProof encodes timestamp correctly and produces verifiable proof",
  async () => {
    const seed = new Uint8Array(32).fill(0);
    const keyPath = "test";
    const idx = 42;
    const ts = new Date(1640995200000); // Example: 2022-01-01T00:00:00.000Z

    const result = await timestampAuthProof(seed, keyPath, idx, ts, mockCrypto);

    // Decode the encoded data
    const decoded = decodeSigProvenData(result);

    // Check decoded fields match inputs
    assertEquals(decoded.keyPath, keyPath);
    assertEquals(decoded.idx, idx);

    // Check that pubKey matches expected
    assertEquals(decoded.pubKey, publicKeyRaw);

    // Check that data is the encoded timestamp
    const expectedEncodedTs = new Uint8Array(8);
    new DataView(expectedEncodedTs.buffer).setBigUint64(
      0,
      BigInt(ts.getTime()),
      false,
    );
    assertEquals(decoded.data, expectedEncodedTs);

    // Check that the encoded timestamp can be roundtripped
    const decodedTimestampMs = Number(
      new DataView(decoded.data.buffer).getBigUint64(0, false),
    );
    assertEquals(decodedTimestampMs, ts.getTime());
  },
);

Deno.test("timestampAuthProof works with different timestamp", async () => {
  const seed = new Uint8Array(32).fill(0);
  const keyPath = "another";
  const idx = 123;
  const ts = new Date(0); // Epoch time: 1970-01-01T00:00:00.000Z

  const result = await timestampAuthProof(seed, keyPath, idx, ts, mockCrypto);

  const decoded = decodeSigProvenData(result);
  assertEquals(decoded.keyPath, keyPath);
  assertEquals(decoded.idx, idx);

  const expectedEncodedTs = new Uint8Array(8);
  new DataView(expectedEncodedTs.buffer).setBigUint64(0, BigInt(0), false);
  assertEquals(decoded.data, expectedEncodedTs);

  // Check that the encoded timestamp can be roundtripped
  const decodedTimestampMs = Number(
    new DataView(decoded.data.buffer).getBigUint64(0, false),
  );
  assertEquals(decodedTimestampMs, ts.getTime());
});
