import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { checksumEntRevs, encodeEntRev } from "../../shared/checksum.ts";
import { Status } from "../../shared/consts.ts";
import type { IEntRev } from "../../shared/types.ts";
import { bytesEqual } from "../../shared/binary.ts";
import libsodiumCrypto from "../src/crypto.ts";

Deno.test("encodeEntRev is deterministic", () => {
  const [eid, stEid] = makeEID({
    id: new Uint8Array(8).fill(0xab),
    ts: new Date(1_700_000_000_000),
  });
  assertEquals(stEid, Status.Success);
  if (!eid) return;

  const rev: IEntRev = {
    eid,
    updatedAt: new Date(1_700_000_000_500),
    ctr: 3,
  };
  const [a, sa] = encodeEntRev(rev);
  const [b, sb] = encodeEntRev(rev);
  assertEquals(sa, Status.Success);
  assertEquals(sb, Status.Success);
  if (!a || !b) return;
  assertEquals(bytesEqual(a, b), true);
  assertEquals(a.length > 0, true);
});

Deno.test("checksumEntRevs order-independent", async () => {
  const [e1, s1] = makeEID({ id: new Uint8Array(8).fill(1), ts: new Date(0) });
  const [e2, s2] = makeEID({ id: new Uint8Array(8).fill(2), ts: new Date(0) });
  assertEquals(s1, Status.Success);
  assertEquals(s2, Status.Success);
  if (!e1 || !e2) return;

  const a: IEntRev = { eid: e1, updatedAt: new Date(100), ctr: 0 };
  const b: IEntRev = { eid: e2, updatedAt: new Date(200), ctr: 1 };

  const [c1, st1] = await checksumEntRevs([a, b], libsodiumCrypto);
  const [c2, st2] = await checksumEntRevs([b, a], libsodiumCrypto);
  assertEquals(st1, Status.Success);
  assertEquals(st2, Status.Success);
  if (!c1 || !c2) return;
  assertEquals(bytesEqual(c1, c2), true);

  const [c3, st3] = await checksumEntRevs([a], libsodiumCrypto);
  assertEquals(st3, Status.Success);
  if (!c3) return;
  assertEquals(bytesEqual(c1, c3), false);
});

Deno.test("checksumEntRevs empty", async () => {
  const [c, st] = await checksumEntRevs([], libsodiumCrypto);
  assertEquals(st, Status.Success);
  if (!c) return;
  const empty = await libsodiumCrypto.blake3(new Uint8Array(0));
  assertEquals(bytesEqual(c, empty), true);
});
