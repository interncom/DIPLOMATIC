import { Encoder } from "../codec.ts";
import { type IKDM, kdmCodec } from "../codecs/kdm.ts";
import { hashBytes, Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { NobleCrypto } from "./noble.ts";

// Purpose tags domain-separate PDKs to limit the damage of a stolen key.
export const Purpose = {
  Identity: "diplomatic.identity.v1",
  Cipher: "diplomatic.cipher.v1",
  Bind: "diplomatic.bind.v1",
  BindTag: "diplomatic.bindtag.v1",
  Fingerprint: "diplomatic.fingerprint.v1",
  Pair: "diplomatic.qrpair.v1",
  BagKdm: "diplomatic.bagkdm.v1",
} as const;
export type Purpose = typeof Purpose[keyof typeof Purpose];

const pdkSymbol = Symbol("PurposeDerivedKey");
export type PurposeDerivedKey<P extends Purpose> = Uint8Array & {
  readonly [pdkSymbol]: P;
};

const childKeySymbol = Symbol("ChildKey");
export type ChildKey<P extends Purpose> = Uint8Array & {
  readonly [childKeySymbol]: P;
};

// Null KDM: default child of a PDK (empty label, index 0).
export const nullKDM: IKDM = Object.freeze({ label: "", index: 0 });

const noble = new NobleCrypto();

function asPDK<P extends Purpose>(
  b: Uint8Array,
  _p: P,
): PurposeDerivedKey<P> {
  return b as Uint8Array as PurposeDerivedKey<P>;
}

function asChild<P extends Purpose>(b: Uint8Array): ChildKey<P> {
  return b as Uint8Array as ChildKey<P>;
}

// Brands 32-byte material as a child key of `purpose` (e.g. a stored bind tag).
export function asChildKey<P extends Purpose>(
  bytes: Uint8Array,
  _purpose: P,
): ValStat<ChildKey<P>> {
  if (bytes.byteLength !== hashBytes) return err(Status.InvalidParam);
  return ok(asChild<P>(bytes));
}

// Encodes structured KDM; raw bytes pass through.
function kdm2bytes(kdm: Uint8Array | IKDM): ValStat<Uint8Array> {
  if (kdm instanceof Uint8Array) return ok(kdm);
  const enc = new Encoder();
  const stat = kdmCodec.encode(enc, kdm);
  if (stat !== Status.Success) return err(stat);
  return ok(enc.result());
}

// BLAKE3 throws on a bad key length, or if both key and context are set.
async function blake3(
  data: Uint8Array,
  opts: { context: string } | { key: Uint8Array },
): Promise<ValStat<Uint8Array>> {
  try {
    return ok(await noble.blake3(data, opts));
  } catch {
    return err(Status.CryptoError);
  }
}

// derivePDK derives a purpose-derived key from a parent (e.g. master seed).
export async function derivePDK<P extends Purpose>({
  parent,
  purpose,
}: {
  parent: Uint8Array;
  purpose: P;
}): Promise<ValStat<PurposeDerivedKey<P>>> {
  const [pdk, st] = await blake3(parent, { context: purpose });
  if (st !== Status.Success) return err(st);
  return ok(asPDK(pdk, purpose));
}

// deriveChild derives a child key from a PDK. Structured KDM is encoded first.
export async function deriveChild<P extends Purpose>({
  pdk,
  kdm,
}: {
  pdk: PurposeDerivedKey<P>;
  kdm: Uint8Array | IKDM;
}): Promise<ValStat<ChildKey<P>>> {
  const [bytes, st] = kdm2bytes(kdm);
  if (st !== Status.Success) return err(st);
  const [child, cst] = await blake3(bytes, { key: pdk });
  if (cst !== Status.Success) return err(cst);
  return ok(asChild<P>(child));
}

// deriveKey is derivePDK then deriveChild. Wipes the PDK before return.
export async function deriveKey<P extends Purpose>({
  parent,
  purpose,
  kdm,
}: {
  parent: Uint8Array;
  purpose: P;
  kdm: Uint8Array | IKDM;
}): Promise<ValStat<ChildKey<P>>> {
  const [pdk, pst] = await derivePDK({ parent, purpose });
  if (pst !== Status.Success) return err(pst);
  try {
    return await deriveChild({ pdk, kdm });
  } finally {
    pdk.fill(0);
  }
}
