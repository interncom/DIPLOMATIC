// Deno SQLite stores an inline body and skips a row when the blob file cannot be written.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { maxInlineBodyBytes } from "../../../shared/bodykey.ts";
import { kdmBytes, sigBytes, Status } from "../../../shared/consts.ts";
import { asHostRlm, type HostRlm } from "../../../shared/crypto/derivation.ts";
import type { IBag, ISetBagResult, PublicKey } from "../../../shared/types.ts";
import { createSqliteStorage } from "../../../deno/src/storage/sqlite.ts";

function pubKey(): PublicKey {
  return new Uint8Array(32).fill(4) as PublicKey;
}

function rlmOf(realm: number): HostRlm {
  const [rlm, st] = asHostRlm(new Uint8Array(32).fill(realm));
  if (st !== Status.Success || !rlm) throw new Error("rlm");
  return rlm;
}

function bag(n: number, bodyLen: number): IBag {
  return {
    rlm: rlmOf(1),
    sig: new Uint8Array(sigBytes).fill(n),
    kdm: new Uint8Array(kdmBytes).fill(1),
    headCph: new Uint8Array([n, 1, 2, 3]),
    bodyCph: new Uint8Array(bodyLen).fill(n),
  };
}

function seqOf(row: ISetBagResult): number {
  if (row.status !== Status.Success) throw new Error("seq");
  return row.seq;
}

Deno.test("sqlite stores inline bags and skips a failed blob write", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/diplomatic.db`;
  const blobPath = `${path}.blobs`;
  await Deno.writeFile(blobPath, new Uint8Array([1]));
  try {
    const store = createSqliteStorage(path);
    const pk = pubKey();
    const [rows, st] = await store.setBags(pk, [
      bag(1, 8),
      bag(2, maxInlineBodyBytes + 4),
      bag(3, 5),
    ]);
    assertEquals(st, Status.Success);
    assert(rows);
    assertEquals(rows.length, 3);
    assertEquals(seqOf(rows[0]), 1);
    assertEquals(rows[1].status, Status.StorageError);
    assertEquals("seq" in rows[1], false);
    assertEquals(seqOf(rows[2]), 2);

    const [bodies, bSt] = await store.getBodies(pk, rlmOf(1), [1, 2]);
    assertEquals(bSt, Status.Success);
    assert(bodies);
    assertEquals(bodies.length, 2);
    assertEquals(bodies[0].bodyCph.byteLength, 8);
    assertEquals(bodies[0].bodyCph[0], 1);
    assertEquals(bodies[1].bodyCph.byteLength, 5);
    assertEquals(bodies[1].bodyCph[0], 3);

    const blob = await Deno.stat(blobPath);
    assert(blob.isFile);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
