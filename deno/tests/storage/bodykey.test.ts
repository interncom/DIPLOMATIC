// Body locators reject path traversal and differ per call.
import { assert } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { btoh } from "../../../shared/binary.ts";
import { isBodyKey, newBodyKey } from "../../../shared/bodykey.ts";

Deno.test("body key is hex segments and not a path", () => {
  const pub = "ab".repeat(32);
  const rlm = new Uint8Array(32).fill(3);
  const key = newBodyKey(pub, rlm);
  assert(isBodyKey(key));
  assert(key.startsWith(`${pub}/${btoh(rlm)}/`));
  assert(newBodyKey(pub, rlm) !== key);
  assert(!isBodyKey("../etc/passwd"));
  assert(!isBodyKey(`${pub}/../${"00".repeat(16)}`));
  assert(!isBodyKey(`${pub}/${btoh(rlm)}`));
});
