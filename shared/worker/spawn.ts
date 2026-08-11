// Blob-spawn of the embedded sync worker bundle (no app bundler, no trust sets).
// Only Enclave.spawnSyncWorker should seed a worker; this helper only constructs.
//
// Source is base64 in the library bundle: bun --minify drops large string
// literals that look like JS (raw worker.mjs), but keeps opaque base64.

import { DIPLOMATIC_WORKER_SOURCE_B64 } from "./embeddedWorkerSource.ts";

let blobUrl: string | undefined;

function workerSource(): string {
  if (
    typeof DIPLOMATIC_WORKER_SOURCE_B64 !== "string" ||
    DIPLOMATIC_WORKER_SOURCE_B64.length === 0
  ) {
    throw new Error(
      "[DIPLOMATIC] worker source not embedded; run pkg build before spawn",
    );
  }
  // Browser Worker path only; atob is available in all targets we spawn in.
  return atob(DIPLOMATIC_WORKER_SOURCE_B64);
}

function workerBlobUrl(): string {
  if (blobUrl !== undefined) return blobUrl;
  const blob = new Blob([workerSource()], {
    type: "text/javascript",
  });
  blobUrl = URL.createObjectURL(blob);
  return blobUrl;
}

/**
 * Construct a DIPLOMATIC sync Worker from the embedded bundle.
 * Does not inject seed — use {@link Enclave.spawnSyncWorker} for that.
 */
export function spawnDiplomaticSyncWorker(): Worker {
  if (typeof Worker === "undefined") {
    throw new Error(
      "[DIPLOMATIC] Worker API unavailable; cannot spawn sync worker",
    );
  }
  return new Worker(workerBlobUrl(), { type: "module" });
}
