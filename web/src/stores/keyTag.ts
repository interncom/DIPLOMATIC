// Key tag: names which master an account belongs to, without storing the seed.
//
// Stored: random nonce n + fingerprint-PDK child of that nonce.
// Two rows of the same master use different nonces, so the children do not match.

import { btoh } from "../shared/binary";
import { Status } from "../shared/consts";
import { asChildKey, type PDK, Purpose } from "../shared/crypto/derivation";
import type { Enclave } from "../shared/crypto/enclave";
import type { ICrypto } from "../shared/types";
import { err, ok, type ValStat } from "../shared/valstat";

/** Nonce plus the fingerprint child that names the master. */
export type KeyTag = {
  n: Uint8Array;
  h: PDK["Fingerprint"];
};

/** A matching key tag. `next` is set when a legacy row should be rewritten. */
export type KeyTagHit = { ok: true; next?: KeyTag } | { ok: false };

// TODO(accounts-sunset): old rows stored blake3 of an identity pubkey.
const LEGACY_PIN_PREFIX = "diplomatic.pin/";

// Fingerprint-PDK child of `nonce`.
export async function keyTagDigest(
  enclave: Enclave,
  nonce: Uint8Array,
): Promise<ValStat<PDK["Fingerprint"]>> {
  const [child, st] = await enclave.fingerprint(nonce);
  if (st !== Status.Success) return err(st);
  return asChildKey(child.slice(), Purpose.Fingerprint);
}

// Draws a nonce and the fingerprint child that names this master.
export async function makeKeyTag(
  crypto: ICrypto,
  enclave: Enclave,
): Promise<ValStat<KeyTag>> {
  const n = await crypto.gen256BitSecureRandomSeed();
  const [h, st] = await keyTagDigest(enclave, n);
  if (st !== Status.Success) return err(st);
  return ok({ n, h });
}

// Matches `tag` to `enclave`. A legacy hit sets `next` to the fingerprint child.
export async function keyTagMatches(
  crypto: ICrypto,
  enclave: Enclave,
  tag: KeyTag,
): Promise<KeyTagHit> {
  const [h, st] = await keyTagDigest(enclave, tag.n);
  if (st !== Status.Success) return { ok: false };
  if (bytesEq(h, tag.h)) return { ok: true };
  const [old, ost] = await legacyPinDigest(crypto, enclave, tag.n);
  if (ost !== Status.Success) return { ok: false };
  if (!bytesEq(old, tag.h)) return { ok: false };
  return { ok: true, next: { n: tag.n.slice(), h } };
}

// Reads a stored key tag. Undefined when `raw` is not {n, h}.
export function decodeKeyTag(raw: unknown): KeyTag | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Partial<KeyTag>;
  if (!(o.n instanceof Uint8Array) || !(o.h instanceof Uint8Array)) {
    return undefined;
  }
  if (o.n.byteLength < 1) return undefined;
  // TODO(accounts-sunset): a legacy pubkey-hash is the same width, so it brands too.
  const [h, st] = asChildKey(o.h.slice(), Purpose.Fingerprint);
  if (st !== Status.Success) return undefined;
  return { n: o.n.slice(), h };
}

// Copies n and h.
export function cloneKeyTag(tag: KeyTag): KeyTag {
  const n = tag.n.slice();
  const [h, st] = asChildKey(tag.h.slice(), Purpose.Fingerprint);
  if (st !== Status.Success) return { n, h: tag.h };
  return { n, h };
}

// TODO(accounts-sunset): blake3(pubkey) at diplomatic.pin/<hex(nonce)>.
async function legacyPinDigest(
  crypto: ICrypto,
  enclave: Enclave,
  nonce: Uint8Array,
): Promise<ValStat<Uint8Array>> {
  const [idnt, st] = await enclave.deriveIdentity({
    label: LEGACY_PIN_PREFIX + btoh(nonce),
    index: 0,
  });
  if (st !== Status.Success) return err(st);
  return ok(await crypto.blake3(idnt.publicKey));
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= a[i] ^ b[i];
  return d === 0;
}
