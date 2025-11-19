import type { ICrypto } from "./types.ts";

// Op Layout:
// === Plaintext Section [106 bytes] ===
// IDX - host keypair derivation index (0 until rotated) [2 bytes]
// SIG - Ed25519 signature of HASH, using host-specific keypair (determined by IDX) [64 bytes]
// HASH - SHA256 hash of LEN ++ PATH ++ CIPHERHEAD [32 bytes]
// LEN - Byte length of KEYPATH + CIPHERHEAD + CIPHERTEXT [8 bytes]
// === Encrypted Section [76 + LEN bytes] ===
// KEYPATH - Derivation path for encryption key [8 bytes]
// CIPHERHEAD [68 bytes]
// CIPHERTEXT [LEN bytes]

// CIPHERHEAD Layout [68 bytes]
// EID - Entity ID [16 bytes]
// CLK - Wall clock [8 bytes]
// CTR - Counter (CLK ++ CTR form the Hybrid Logical Clock HLC) [4 bytes]
// SHA - SHA256 hash of CIPHERBODY [32 bytes]
// LEN - body size in bytes [8 bytes]
// CIPHERBODY - MSGPACK-encoded application-specific representation of entity [LEN bytes]

// The plaintext header section is only for client/host communication.
// It is host-specific (IDX and SIG).
// The client discards it after downloading and successfully decrypting the op.

// Client only needs to retain KEYPATH, EID, CLK, CTR [36 bytes].
// Rest of the data it can regenerate dynamically.

// The minimal data necessary to encode an op.
interface IProtoOpMinimal {
  eid: Uint8Array;
  clk: Date;
  ctr: number;
  body: Uint8Array;
}

interface IProtoOpHost {
  sig: Uint8Array;
  hash: Uint8Array;
  len: number;
  cipherOp: Uint8Array;
}

type EncryptedOp = Uint8Array;
type EncodedOp = Uint8Array;

const keyPathBytes = 8;

const idxBytes = 4;
const sigBytes = 64;

export async function encodeOpForHost(
  idx: number,
  op: IProtoOpHost,
): Promise<EncodedOp> {
  const encoded = new Uint8Array(
    idxBytes + sigBytes + shaBytes + lenBytes + op.cipherOp.length,
  );

  encoded.set(idx, 0);
  encoded.set(op.sig, idxBytes);
  encoded.set(op.hash, idxBytes + sigBytes);
  encoded.set(op.len, idxBytes + sigBytes + shaBytes);
  encoded.set(op.cipherOp, idxBytes + sigBytes + shaBytes + lenBytes);
  return encoded;
}

export async function formOpForHost(
  keyPair: KeyPair, // Based on hostIdx (for rotation)
  cipherOp: EncryptedOp,
  crypto: ICrypto,
): Promise<IProtoOpHost> {
  const keyPath = "";
  const len = keyPathBytes + cipherOp.length;

  const hashSrc = new Uint8Array(len);
  hashSrc.set(keyPath, 0);
  hashSrc.set(cipherOp, keyPathBytes);
  const hash = await crypto.sha256Hash(hashSrc);

  const sig = crypto.signEd25519(hash, keyPair.privateKey);
  return {
    sig,
    hash,
    len,
    cipherOp,
  };
}

// TODO: implement keyPath.
// const keyPathBytes = 8;
const eidBytes = 16;
const clkBytes = 8;
const ctrBytes = 4;
const shaBytes = 32;
const lenBytes = 8;
export async function encryptOp(
  op: IProtoOpMinimal,
  crypto: ICrypto,
): Promise<EncryptedOp> {
  const len = op.body.length;
  const sha = await crypto.sha256Hash(op.body);

  const cipher = new Uint8Array(
    eidBytes + clkBytes + ctrBytes + shaBytes + lenBytes,
  );

  cipher.set(op.eid, 0);
  cipher.set(op.clk, eidBytes);
  cipher.set(op.ctr, eidBytes + clkBytes);
  cipher.set(sha, eidBytes + clkBytes + ctrBytes);
  cipher.set(len, eidBytes + clkBytes + ctrBytes + shaBytes);
  cipher.set(op.body, eidBytes + clkBytes + ctrBytes + shaBytes + lenBytes);
  return cipher;
}
