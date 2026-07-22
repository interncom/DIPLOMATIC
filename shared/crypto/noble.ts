import { randomBytes } from "@noble/ciphers/webcrypto";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa";
import { blake3 } from "@noble/hashes/blake3";
import { btoh } from "../binary.ts";
import type {
  DerivationSeed,
  Hash,
  ICrypto,
  KeyPair,
  PrivateKey,
  PublicKey,
} from "../types.ts";

/**
 * PKCS#8 wrapper for a 32-byte Ed25519 seed (RFC 8410).
 * 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || seed
 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
]);

function ed25519Pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  out.set(ED25519_PKCS8_PREFIX);
  out.set(seed.subarray(0, 32), ED25519_PKCS8_PREFIX.length);
  return out;
}

function toBytes(message: Uint8Array | string): Uint8Array {
  return typeof message === "string"
    ? new TextEncoder().encode(message)
    : message;
}

/** Copy into a fresh ArrayBuffer so SubtleCrypto accepts BufferSource. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * ICrypto: noble for XSalsa20 + blake3; native WebCrypto for all Ed25519.
 */
export class NobleCrypto implements ICrypto {
  private verifyKeys = new Map<string, CryptoKey>();
  private signKeys = new Map<string, CryptoKey>();

  async genRandomBytes(bytes: number): Promise<Uint8Array> {
    return randomBytes(bytes);
  }

  async gen256BitSecureRandomSeed(): Promise<Uint8Array> {
    return randomBytes(32);
  }

  async encryptXSalsa20Poly1305Combined(
    data: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    const nonce = randomBytes(24); // XSalsa20 nonce size
    const cipher = xsalsa20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(data);
    // Combine nonce + ciphertext like libsodium crypto_secretbox
    return new Uint8Array([...nonce, ...ciphertext]);
  }

  async decryptXSalsa20Poly1305Combined(
    data: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    const nonce = data.slice(0, 24);
    const ciphertext = data.slice(24);
    const cipher = xsalsa20poly1305(key, nonce);
    return cipher.decrypt(ciphertext);
  }

  async deriveEd25519KeyPair(derivationSeed: DerivationSeed): Promise<KeyPair> {
    const seed = derivationSeed; // 32-byte seed
    // Extractable import so we can export the public key (JWK x / raw).
    const pkcs8 = ed25519Pkcs8FromSeed(seed);
    const priv = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(pkcs8),
      { name: "Ed25519" },
      true,
      ["sign"],
    );
    const jwk = await globalThis.crypto.subtle.exportKey("jwk", priv);
    if (typeof jwk.x !== "string") {
      throw new Error("Ed25519 JWK missing x");
    }
    const pubCryptoKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: jwk.x },
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    const publicKey = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("raw", pubCryptoKey),
    );
    // Libsodium format: privateKey = seed + publicKey (64 bytes total)
    const privateKey = new Uint8Array(64);
    privateKey.set(seed, 0);
    privateKey.set(publicKey, 32);
    // Cache for sign/verify (extractable keys are fine for our use).
    this.signKeys.set(btoh(seed), priv);
    this.verifyKeys.set(btoh(publicKey), pubCryptoKey);
    return {
      keyType: "ed25519",
      privateKey: privateKey as PrivateKey,
      publicKey: publicKey as PublicKey,
    };
  }

  private async importSignKey(secKey: Uint8Array): Promise<CryptoKey> {
    // Libsodium-format secret key: first 32 bytes are the seed.
    const seed = secKey.subarray(0, 32);
    const cacheKey = btoh(seed);
    const cached = this.signKeys.get(cacheKey);
    if (cached) return cached;
    const pkcs8 = ed25519Pkcs8FromSeed(seed);
    const key = await globalThis.crypto.subtle.importKey(
      "pkcs8",
      toArrayBuffer(pkcs8),
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    this.signKeys.set(cacheKey, key);
    return key;
  }

  private async importVerifyKey(pubKey: Uint8Array): Promise<CryptoKey> {
    const cacheKey = btoh(pubKey);
    const cached = this.verifyKeys.get(cacheKey);
    if (cached) return cached;
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      toArrayBuffer(pubKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    this.verifyKeys.set(cacheKey, key);
    return key;
  }

  async signEd25519(
    message: Uint8Array | string,
    secKey: Uint8Array,
  ): Promise<Uint8Array> {
    const msg = toBytes(message);
    const key = await this.importSignKey(secKey);
    const sig = await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      toArrayBuffer(msg),
    );
    return new Uint8Array(sig);
  }

  async checkSigEd25519(
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: Uint8Array,
  ): Promise<boolean> {
    const msg = toBytes(message);
    try {
      const key = await this.importVerifyKey(pubKey);
      return await globalThis.crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        toArrayBuffer(sig),
        toArrayBuffer(msg),
      );
    } catch {
      // Invalid key material / unsupported algorithm → not a valid signature.
      return false;
    }
  }

  async blake3(data: Uint8Array): Promise<Hash> {
    return blake3(data) as Hash;
  }
}
