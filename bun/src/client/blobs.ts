// Message bodies stored as files under the app folder's blobs directory.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { btoh } from "../../../web/src/shared/binary.ts";
import { hashBytes, Status } from "../../../web/src/shared/consts.ts";
import { err, ok, type ValStat } from "../../../web/src/shared/valstat.ts";

const nameRe = /^[0-9a-f]{64}$/;

// blobName is the file name for a message head hash.
// blobName returns undefined when key is not a 32-byte hash.
export function blobName(key: Uint8Array): string | undefined {
  if (key.byteLength !== hashBytes) return undefined;
  return btoh(key);
}

// writeBlob writes body at dir/name. name is a hash hex, so it cannot escape dir.
export async function writeBlob(
  dir: string,
  name: string,
  body: Uint8Array,
): Promise<ValStat<void>> {
  if (!nameRe.test(name)) return err(Status.InvalidParam);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), body);
  } catch {
    try {
      await rm(join(dir, name), { force: true });
    } catch {
      // not written
    }
    return err(Status.StorageError);
  }
  return ok(undefined);
}

// readBlob reads one spilled body.
export async function readBlob(
  dir: string,
  name: string,
): Promise<ValStat<Uint8Array>> {
  if (!nameRe.test(name)) return err(Status.InvalidParam);
  try {
    const bytes = await readFile(join(dir, name));
    return ok(new Uint8Array(bytes));
  } catch {
    return err(Status.StorageError);
  }
}

// dropBlobs removes spilled bodies. Missing files are ignored.
export async function dropBlobs(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    if (!nameRe.test(name)) continue;
    try {
      await rm(join(dir, name), { force: true });
    } catch {
      // already gone
    }
  }
}
