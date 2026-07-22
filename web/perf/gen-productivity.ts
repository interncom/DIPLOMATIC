// Generate fixtures/productivity/msgs.msgpack (+ meta.json).
// Run from repo root:
//   bun run web/perf/gen-productivity.ts
// Optional scale (smoke): NUM_ENTS=100 NUM_MSGS=700 bun run web/perf/gen-productivity.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  datasetStats,
  generateProductivityMsgs,
  packDataset,
  PROD_DATASET_VERSION,
  PROD_NUM_ENTS,
  PROD_NUM_MSGS,
  PROD_SEED,
} from "./productivity";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "../../fixtures/productivity");

const numEnts = Number(process.env.NUM_ENTS ?? PROD_NUM_ENTS);
const numMsgs = Number(process.env.NUM_MSGS ?? PROD_NUM_MSGS);
const seed = Number(process.env.SEED ?? PROD_SEED);

console.log(
  `Generating productivity dataset: ${numMsgs} msgs / ${numEnts} ents (seed=${seed})`,
);
const t0 = performance.now();
const recs = generateProductivityMsgs({ seed, numEnts, numMsgs });
const stats = datasetStats(recs);
const file = {
  v: PROD_DATASET_VERSION,
  seed,
  ents: stats.ents,
  msgs: stats.msgs,
  recs,
};
const bytes = packDataset(file);
const genMs = performance.now() - t0;

mkdirSync(outDir, { recursive: true });
const msgsPath = join(outDir, "msgs.msgpack");
const metaPath = join(outDir, "meta.json");
writeFileSync(msgsPath, bytes);
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      version: PROD_DATASET_VERSION,
      seed,
      entities: stats.ents,
      messages: stats.msgs,
      avgMsgsPerEntity: Number(stats.avgMsgsPerEnt.toFixed(3)),
      bodyBytes: stats.bodyBytes,
      meanBodyBytes: Number(stats.meanBody.toFixed(1)),
      msgsWithNote: stats.withNote,
      fileBytes: bytes.length,
      bodyShape:
        '{ type: "todo", body: { text: string; note?: string; done: boolean } }',
      description:
        "Simulated productivity-app dump for sync perf (LPC push/peek/pull). Regenerated via web/perf/gen-productivity.ts.",
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `Wrote ${msgsPath} (${bytes.length} bytes) in ${genMs.toFixed(0)}ms`,
);
console.log(
  `  ents=${stats.ents} msgs=${stats.msgs} avg/ent=${
    stats.avgMsgsPerEnt.toFixed(2)
  } meanBody=${stats.meanBody.toFixed(1)}B notes=${stats.withNote}`,
);
