// RFC 7748 X25519. Checks WebCrypto's exported pub before we emit DHKEReq.

import { Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";

export const X25519_SK_LEN = 32;

const x25519SkSymbol = Symbol("X25519Sk");
export type X25519Sk = Uint8Array & { readonly [x25519SkSymbol]: true };

// Brands a 32-byte X25519 scalar.
export function asX25519Sk(bytes: Uint8Array): ValStat<X25519Sk> {
  if (bytes.byteLength !== X25519_SK_LEN) return err(Status.InvalidParam);
  return ok(bytes as X25519Sk);
}

const P = (1n << 255n) - 19n;
const A24 = 121665n;
const BASE = new Uint8Array(32);
BASE[0] = 9;

// Reads a little-endian 32-byte field element.
function leToN(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

// Writes a field element as 32 little-endian bytes.
function nToLe(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = ((n % P) + P) % P;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

// Decodes an X25519 u-coordinate (clears the high bit).
function decodeU(u: Uint8Array): bigint {
  const t = u.slice();
  t[31] &= 127;
  return leToN(t);
}

// Applies RFC 7748 clamping to a copy of the scalar.
function clamp(sk: X25519Sk): Uint8Array {
  const s = sk.slice();
  s[0] &= 248;
  s[31] &= 127;
  s[31] |= 64;
  return s;
}

// Conditionally swaps a and b when swap is 1.
function cswap(swap: bigint, a: bigint, b: bigint): [bigint, bigint] {
  const mask = -swap;
  const d = (a ^ b) & mask;
  return [a ^ d, b ^ d];
}

// Inverts z in GF(2^255-19).
function modInv(z: bigint): bigint {
  let e = P - 2n;
  let b = ((z % P) + P) % P;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

// Computes X25519(sk, u) per RFC 7748. Clamps a copy of sk.
export function x25519(sk: X25519Sk, u: Uint8Array): Uint8Array {
  const k = clamp(sk);
  const x1 = decodeU(u);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  const bits = leToN(k);
  for (let t = 254; t >= 0; t--) {
    const kt = (bits >> BigInt(t)) & 1n;
    swap ^= kt;
    [x2, x3] = cswap(swap, x2, x3);
    [z2, z3] = cswap(swap, z2, z3);
    swap = kt;
    const a = (x2 + z2) % P;
    const aa = (a * a) % P;
    const b = (x2 - z2 + P) % P;
    const bb = (b * b) % P;
    const e = (aa - bb + P) % P;
    const c = (x3 + z3) % P;
    const d = (x3 - z3 + P) % P;
    const da = (d * a) % P;
    const cb = (c * b) % P;
    const dacb = (da + cb) % P;
    const dacbm = (da - cb + P) % P;
    x3 = (dacb * dacb) % P;
    z3 = (x1 * dacbm * dacbm) % P;
    x2 = (aa * bb) % P;
    z2 = (e * (aa + A24 * e)) % P;
  }
  [x2, x3] = cswap(swap, x2, x3);
  [z2, z3] = cswap(swap, z2, z3);
  k.fill(0);
  return nToLe((x2 * modInv(z2)) % P);
}

// Derives the X25519 public key for a scalar. Used to check WebCrypto before emit.
export function x25519Pub(sk: X25519Sk): Uint8Array {
  return x25519(sk, BASE);
}
