// Blob-spawn of the embedded sync worker bundle (no app bundler, no trust sets).
// Only Enclave.spawnSyncWorker should seed a worker; this helper only constructs.

import { DIPLOMATIC_WORKER_SOURCE } from "./embeddedWorkerSource";

let blobUrl: string | undefined;

function workerBlobUrl(): string {
  if (blobUrl !== undefined) return blobUrl;
  if (
    typeof DIPLOMATIC_WORKER_SOURCE !== "string" ||
    DIPLOMATIC_WORKER_SOURCE.length === 0
  ) {
    throw new Error(
      "[DIPLOMATIC] worker source not embedded; run pkg build before spawn",
    );
  }
  const blob = new Blob([DIPLOMATIC_WORKER_SOURCE], {
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
