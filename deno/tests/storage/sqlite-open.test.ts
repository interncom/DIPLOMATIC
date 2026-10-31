// The host SQLite store opens without loading a second libsqlite3.
import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { Status } from "../../../shared/consts.ts";
import type { PublicKey } from "../../../shared/types.ts";
import sqliteStorage from "../../../deno/src/storage/sqlite.ts";

function pubKey(): PublicKey {
  return new Uint8Array(32).fill(9) as PublicKey;
}

Deno.test("sqlite storage opens", async () => {
  const [has, st] = await sqliteStorage.hasUser(pubKey());
  assertEquals(st, Status.Success);
  assertEquals(has, false);
});
