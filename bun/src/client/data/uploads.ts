// Upload queue in the protocol SQLite file.

import type { Database } from "bun:sqlite";
import type { Hash } from "../../../../web/src/shared/types.ts";
import type { IUploadQueue } from "../../../../web/src/types.ts";
import { readHash } from "../brand.ts";
import { blob, countOf, rows, run } from "../sql.ts";

export class SqlUploads implements IUploadQueue {
  constructor(private db: Database) {}

  async enq(host: string, hshs: Iterable<Hash>) {
    const hashes = [...hshs];
    if (hashes.length === 0) return;
    this.db.transaction(() => {
      for (const hash of hashes) {
        run(
          this.db,
          "INSERT OR IGNORE INTO uploads (host, hash) VALUES (?, ?)",
          host,
          hash,
        );
      }
    })();
  }

  async deq(host: string, hshs: Iterable<Hash>) {
    const hashes = [...hshs];
    if (hashes.length === 0) return;
    this.db.transaction(() => {
      for (const hash of hashes) {
        run(
          this.db,
          "DELETE FROM uploads WHERE host = ? AND hash = ?",
          host,
          hash,
        );
      }
    })();
  }

  async list(host: string): Promise<Hash[]> {
    const out: Hash[] = [];
    for (
      const item of rows(
        this.db,
        "SELECT hash FROM uploads WHERE host = ?",
        host,
      )
    ) {
      const bytes = blob(item, "hash");
      if (bytes === undefined) continue;
      const hash = readHash(bytes);
      if (hash !== undefined) out.push(hash);
    }
    return out;
  }

  async count(): Promise<number> {
    return countOf(this.db, "SELECT COUNT(*) AS n FROM uploads");
  }

  async wipe() {
    run(this.db, "DELETE FROM uploads");
  }
}
