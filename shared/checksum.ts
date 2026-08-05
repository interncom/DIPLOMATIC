// Set checksums over ordered byte records (msg head hashes, encoded ent revs, …).

import { Encoder } from "./codec.ts";
import { Status } from "./consts.ts";
import type { Hash, ICrypto, IEntRev } from "./types.ts";
import { err, ok, type ValStat } from "./valstat.ts";

/** Lexicographic compare of raw bytes (unsigned). */
export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Checksum of a set of byte records (hashes, encoded revs, …).
 *
 * Preimage: blake3( concat( sort_lexicographic(items) ) ).
 * Empty set → blake3(empty). Order of the input iterable is ignored.
 *
 * Equal-length items: concat is trivially unambiguous.
 * Variable-length items: only unambiguous if each item is self-delimiting
 * (e.g. encodeEntRev) so a concat has a unique parse.
 */
export async function checksumSet(
  items: Iterable<Uint8Array>,
  crypto: ICrypto,
): Promise<Hash> {
  const arr = Array.from(items);
  arr.sort(cmpBytes);
  let total = 0;
  for (const h of arr) {
    total += h.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const h of arr) {
    buf.set(h, off);
    off += h.length;
  }
  return crypto.blake3(buf);
}

/**
 * Wire preimage for one EntDB frontier row:
 * varbytes(eid) ‖ date(updatedAt) ‖ varint(ctr). Self-delimiting.
 */
export function encodeEntRev(rev: IEntRev): ValStat<Uint8Array> {
  const enc = new Encoder();
  const s0 = enc.writeVarBytes(rev.eid);
  if (s0 !== Status.Success) return err(s0);
  const s1 = enc.writeDate(rev.updatedAt);
  if (s1 !== Status.Success) return err(s1);
  const s2 = enc.writeVarInt(rev.ctr);
  if (s2 !== Status.Success) return err(s2);
  return ok(enc.result());
}

/**
 * Frontier checksum of live EntDB rows: encode each rev, then
 * {@link checksumSet}.
 */
export async function checksumEntRevs(
  revs: Iterable<IEntRev>,
  crypto: ICrypto,
): Promise<ValStat<Hash>> {
  const recs: Uint8Array[] = [];
  for (const rev of revs) {
    const [rec, st] = encodeEntRev(rev);
    if (st !== Status.Success || !rec) return err(st);
    recs.push(rec);
  }
  return ok(await checksumSet(recs, crypto));
}
