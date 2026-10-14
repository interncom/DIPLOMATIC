import type { IKDM } from "../src/shared/codecs/kdm";
import { Status } from "../src/shared/consts";
import type { BagManager } from "../src/shared/crypto/bagman";
import { nullKDM } from "../src/shared/crypto/derivation";
import type { Enclave } from "../src/shared/crypto/enclave";
import type { ValStat } from "../src/shared/valstat";

// must*: return the value or throw (tests, not ValStat).
// Idnt is the short name for the persona (a BagManager).
// Derives one manager. Throws on a non-Success status.
export async function mustIdnt(
  e: Enclave,
  path = "test",
  idx = 0,
  realm: IKDM = nullKDM,
): Promise<BagManager> {
  const [bagMgr, st] = await e.bagman({ label: path, index: idx }, realm);
  if (st !== Status.Success) {
    throw new Error(`bagman ${st}`);
  }
  return bagMgr;
}

// Same as mustIdnt, via conn.identity().
export async function mustConnIdnt(
  conn: { identity: () => Promise<ValStat<BagManager>> },
): Promise<BagManager> {
  const [id, st] = await conn.identity();
  if (st !== Status.Success) {
    throw new Error(`identity ${st}`);
  }
  return id;
}
