// Hybrid logical clock helpers for message recency (LWW).

import { Decoder } from "./shared/codec";
import { eidCodec } from "./shared/codecs/eid";
import { Status } from "./shared/consts";
import type { EntityID } from "./shared/types";

/** Head fields needed for HLC ordering. */
export type IHlcHead = {
  eid: EntityID;
  off: number;
  ctr: number;
};

/** Wall-clock ms of a message head: eid creation ts + off. */
export function headUpdatedAtMs(head: IHlcHead): number | undefined {
  const dec = new Decoder(head.eid);
  const [parsed, st] = eidCodec.decode(dec);
  if (st !== Status.Success) return undefined;
  return parsed.ts.getTime() + head.off;
}

/**
 * Newest-first HLC compare for pull/exec ordering.
 * Higher updatedAt first; tie-break higher ctr (later update at same ms).
 * Unknown/unparseable eids sort last.
 *
 * EntDB LWW no-ops obsolete msgs against the current row, including permanent
 * tombstones after delete. Newest-first is so app state converges early in a
 * large apply, not to save work on later NoChange applies.
 */
export function compareHeadHlcDesc(a: IHlcHead, b: IHlcHead): number {
  const ta = headUpdatedAtMs(a);
  const tb = headUpdatedAtMs(b);
  if (ta === undefined && tb === undefined) return 0;
  if (ta === undefined) return 1;
  if (tb === undefined) return -1;
  if (tb !== ta) return tb - ta;
  return b.ctr - a.ctr;
}

/** Stable copy sorted newest-first by HLC. */
export function sortByHlcDesc<T>(
  items: readonly T[],
  headOf: (t: T) => IHlcHead,
): T[] {
  return items.slice().sort((x, y) => compareHeadHlcDesc(headOf(x), headOf(y)));
}
