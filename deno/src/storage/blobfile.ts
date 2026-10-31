// Files for bag bodies stored outside a SQLite row.

import { Status } from "../../../shared/consts.ts";
import { isBodyKey } from "../../../shared/bodykey.ts";
import { err, ok, type ValStat } from "../../../shared/valstat.ts";

// bodyPath joins a directory and a body key.
// bodyPath returns InvalidParam when the key is not a locator.
function bodyPath(dir: string, key: string): ValStat<string> {
  if (!isBodyKey(key)) return err(Status.InvalidParam);
  return ok(`${dir}/${key}`);
}

// writeBodyFile writes bodyCph at dir/key and creates the parent directory.
// writeBodyFile returns InvalidParam for a bad key and StorageError on a filesystem failure.
export async function writeBodyFile(
  dir: string,
  key: string,
  body: Uint8Array,
): Promise<ValStat<void>> {
  const [path, st] = bodyPath(dir, key);
  if (st !== Status.Success) return err(st);
  const slash = path.lastIndexOf("/");
  try {
    if (slash > 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
    await Deno.writeFile(path, body);
  } catch {
    // Drop a partial file, then return StorageError.
    try {
      await Deno.remove(path);
    } catch {
      // not written
    }
    return err(Status.StorageError);
  }
  return ok(undefined);
}

// readBodyFile reads one off-row body.
// readBodyFile returns StorageError for a bad key or a missing file.
export async function readBodyFile(
  dir: string,
  key: string,
): Promise<ValStat<Uint8Array>> {
  const [path, st] = bodyPath(dir, key);
  if (st !== Status.Success) return err(Status.StorageError);
  try {
    return ok(await Deno.readFile(path));
  } catch {
    return err(Status.StorageError);
  }
}

// dropBodyFiles removes body files after a failed insert.
// dropBodyFiles ignores missing files.
export async function dropBodyFiles(
  dir: string,
  keys: string[],
): Promise<void> {
  for (const key of keys) {
    if (!isBodyKey(key)) continue;
    try {
      await Deno.remove(`${dir}/${key}`);
    } catch {
      // already gone
    }
  }
}
