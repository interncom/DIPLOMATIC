// Off-row body files round-trip and reject a key that is not a locator.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { bytesEqual } from "../../../shared/binary.ts";
import { Status } from "../../../shared/consts.ts";
import {
  dropBodyFiles,
  readBodyFile,
  writeBodyFile,
} from "../../../deno/src/storage/blobfile.ts";

function keyFor(n: number): string {
  const pub = n.toString(16).padStart(2, "0").repeat(32);
  const rlm = "ab".repeat(32);
  const rand = "cd".repeat(16);
  return `${pub}/${rlm}/${rand}`;
}

Deno.test("body file round trip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const key = keyFor(1);
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const [, wst] = await writeBodyFile(dir, key, body);
    assertEquals(wst, Status.Success);
    const [got, rst] = await readBodyFile(dir, key);
    assertEquals(rst, Status.Success);
    assert(got);
    assert(bytesEqual(got, body));
    await dropBodyFiles(dir, [key]);
    const [, miss] = await readBodyFile(dir, key);
    assertEquals(miss, Status.StorageError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("body file rejects a key that escapes the directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const [, st] = await writeBodyFile(dir, "../x", new Uint8Array([1]));
    assertEquals(st, Status.InvalidParam);
    const left = [];
    for await (const ent of Deno.readDir(dir)) left.push(ent.name);
    assertEquals(left.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
