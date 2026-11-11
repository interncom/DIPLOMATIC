// Brands bytes read back from SQLite after checking they are well formed.

import { Decoder } from "../../../web/src/shared/codec.ts";
import { eidCodec, makeEID } from "../../../web/src/shared/codecs/eid.ts";
import { bytesEqual } from "../../../web/src/shared/binary.ts";
import { hashBytes, Status } from "../../../web/src/shared/consts.ts";
import type { EntityID, Hash } from "../../../web/src/shared/types.ts";

// readEID checks that bytes are a canonical eid and returns that eid.
export function readEID(bytes: Uint8Array): EntityID | undefined {
  const dec = new Decoder(bytes);
  const [parsed, st] = dec.readStruct(eidCodec);
  if (st !== Status.Success || !dec.done()) return undefined;
  const [again, se] = makeEID(parsed);
  if (se !== Status.Success || again === undefined) return undefined;
  if (!bytesEqual(again, bytes)) return undefined;
  return again;
}

// readHash checks a 32-byte blake3 and reattaches the Hash brand.
export function readHash(bytes: Uint8Array): Hash | undefined {
  if (bytes.byteLength !== hashBytes) return undefined;
  return bytes as Uint8Array as Hash;
}
