import { Status } from "../src/shared/consts";
import type { Enclave, Identity } from "../src/shared/crypto/enclave";
import type { ValStat } from "../src/shared/valstat";

// must*: return the value or throw (tests, not ValStat).
// Idnt is the short name for Identity.
// Derives an identity. Throws on a non-Success status.
export async function mustIdnt(
  e: Enclave,
  path = "test",
  idx = 0,
): Promise<Identity> {
  const [id, st] = await e.deriveIdentity(path, idx);
  if (st !== Status.Success) {
    throw new Error(`deriveIdentity ${st}`);
  }
  return id;
}

// Same as mustIdnt, via conn.identity().
export async function mustConnIdnt(
  conn: { identity: () => Promise<ValStat<Identity>> },
): Promise<Identity> {
  const [id, st] = await conn.identity();
  if (st !== Status.Success) {
    throw new Error(`identity ${st}`);
  }
  return id;
}
