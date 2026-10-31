// Locator for a bag body stored outside the SQL row.

import { btoh } from "./binary.ts";

// Bodies larger than this stay out of the bag row.
// D1 rejects a row over 2_000_000 bytes. 1 MiB leaves room for headCph
// and matches the client's soft push cap (defaultMaxPushBytes).
export const maxInlineBodyBytes = 1 << 20;

// pubKey hex / rlm hex / 16 random bytes. No "..", so it cannot escape a dir.
const bodyKeyRe = /^[0-9a-f]{64}\/[0-9a-f]{64}\/[0-9a-f]{32}$/;

// True when key is a locator this host wrote.
export function isBodyKey(key: string): boolean {
  return bodyKeyRe.test(key);
}

// Fresh locator. The same string is an R2 object key or a relative file path.
export function newBodyKey(pubKeyHex: string, rlm: Uint8Array): string {
  const rand = new Uint8Array(16);
  crypto.getRandomValues(rand);
  return `${pubKeyHex}/${btoh(rlm)}/${btoh(rand)}`;
}
