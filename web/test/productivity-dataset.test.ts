import { describe, expect, test } from "vitest";
import {
  generateProductivityMsgs,
  msgsPerEntity,
  packDataset,
  unpackDataset,
  datasetStats,
  PROD_DATASET_VERSION,
  recsToMessages,
} from "../perf/productivity";
import libsodiumCrypto from "../src/crypto";

describe("productivity dataset", () => {
  test("msgsPerEntity sums and min 1", () => {
    const per = msgsPerEntity(6500, 42_000);
    expect(per.length).toBe(6500);
    let sum = 0;
    let min = Infinity;
    for (const n of per) {
      sum += n;
      if (n < min) min = n;
    }
    expect(sum).toBe(42_000);
    expect(min).toBeGreaterThanOrEqual(1);
  });

  test("generate is deterministic and matches counts", () => {
    const a = generateProductivityMsgs({ seed: 1, numEnts: 20, numMsgs: 140 });
    const b = generateProductivityMsgs({ seed: 1, numEnts: 20, numMsgs: 140 });
    expect(a.length).toBe(140);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].off).toBe(b[i].off);
      expect(a[i].ctr).toBe(b[i].ctr);
      expect(a[i].e).toEqual(b[i].e);
      expect(a[i].b).toEqual(b[i].b);
    }
    const stats = datasetStats(a);
    expect(stats.msgs).toBe(140);
    expect(stats.ents).toBe(20);
    expect(stats.avgMsgsPerEnt).toBeCloseTo(7, 5);
  });

  test("pack/unpack roundtrip", () => {
    const recs = generateProductivityMsgs({ seed: 2, numEnts: 5, numMsgs: 20 });
    const bytes = packDataset({
      v: PROD_DATASET_VERSION,
      seed: 2,
      ents: 5,
      msgs: 20,
      recs,
    });
    const file = unpackDataset(bytes);
    expect(file.v).toBe(PROD_DATASET_VERSION);
    expect(file.recs.length).toBe(20);
    expect(file.recs[0].e).toEqual(recs[0].e);
    expect(file.recs[0].b).toEqual(recs[0].b);
  });

  test("recsToMessages sets len and hsh", async () => {
    const recs = generateProductivityMsgs({ seed: 3, numEnts: 3, numMsgs: 10 });
    const msgs = await recsToMessages(recs, libsodiumCrypto);
    expect(msgs.length).toBe(10);
    for (const m of msgs) {
      expect(m.len).toBe(m.bod?.length ?? 0);
      expect(m.hsh?.length).toBe(32);
      expect(m.ctr).toBeGreaterThanOrEqual(0);
    }
  });
});
