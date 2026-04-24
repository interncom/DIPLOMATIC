import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import * as sodium from "https://raw.githubusercontent.com/interncom/libsodium.js/esm/dist/modules/libsodium-esm-wrappers.js";
import { LibsodiumCrypto } from "../../shared/crypto/libsodium.ts";
import { NobleCrypto } from "../../shared/crypto/noble.ts";
import type { DerivationSeed } from "../../shared/types.ts";

Deno.test("crypto interop between libsodium and noble implementations", async () => {
  // Initialize libsodium
  await sodium.ready;
  const libsodiumCrypto = new LibsodiumCrypto(sodium);
  const nobleCrypto = new NobleCrypto();

  // Test 1: Random bytes generation (should be different but same length)
  const libRandom = await libsodiumCrypto.genRandomBytes(32);
  const nobleRandom = await nobleCrypto.genRandomBytes(32);
  assertEquals(libRandom.length, 32);
  assertEquals(nobleRandom.length, 32);

  // Test 2: Secure seed generation
  const libSeed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const nobleSeed = await nobleCrypto.gen256BitSecureRandomSeed();
  assertEquals(libSeed.length, 32);
  assertEquals(nobleSeed.length, 32);

  // Test 3: Blake3 hash compatibility
  const testData = new Uint8Array([1, 2, 3, 4, 5]);
  const libHash = await libsodiumCrypto.blake3(testData);
  const nobleHash = await nobleCrypto.blake3(testData);
  assertEquals(libHash, nobleHash);

  // Test 4: Ed25519 key pair derivation compatibility
  const seed = new Uint8Array(32).fill(0xAA) as DerivationSeed; // Fixed seed for deterministic testing
  const libKeyPair = await libsodiumCrypto.deriveEd25519KeyPair(seed);
  const nobleKeyPair = await nobleCrypto.deriveEd25519KeyPair(seed);
  assertEquals(libKeyPair.publicKey, nobleKeyPair.publicKey);
  assertEquals(libKeyPair.privateKey, nobleKeyPair.privateKey);

  // Test 5: Ed25519 signing and verification interop
  const message = "Hello, world!";
  const libSig = await libsodiumCrypto.signEd25519(
    message,
    libKeyPair.privateKey,
  );
  // For noble signing, use just the seed part (first 32 bytes) of the private key
  const noblePrivateKeySeed = nobleKeyPair.privateKey.slice(0, 32);
  const nobleSig = await nobleCrypto.signEd25519(message, noblePrivateKeySeed);

  // Cross-verification: lib sig verified by noble
  const libSigVerifiedByNoble = await nobleCrypto.checkSigEd25519(
    libSig,
    message,
    libKeyPair.publicKey,
  );
  assertEquals(libSigVerifiedByNoble, true);

  // Cross-verification: noble sig verified by lib
  const nobleSigVerifiedByLib = await libsodiumCrypto.checkSigEd25519(
    nobleSig,
    message,
    nobleKeyPair.publicKey,
  );
  assertEquals(nobleSigVerifiedByLib, true);

  // Test 6: XSalsa20Poly1305 encryption/decryption interop
  const key = new Uint8Array(32).fill(0xBB); // Fixed key for testing
  const plaintext = new Uint8Array([10, 20, 30, 40, 50]);

  // Encrypt with libsodium, decrypt with noble
  const libCiphertext = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(
    plaintext,
    key,
  );
  const decryptedByNoble = await nobleCrypto.decryptXSalsa20Poly1305Combined(
    libCiphertext,
    key,
  );
  assertEquals(plaintext, decryptedByNoble);

  // Encrypt with noble, decrypt with libsodium
  const nobleCiphertext = await nobleCrypto.encryptXSalsa20Poly1305Combined(
    plaintext,
    key,
  );
  const decryptedByLib = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
    nobleCiphertext,
    key,
  );
  assertEquals(plaintext, decryptedByLib);
});
