/*
1mm edits, inserts, IoT scenario, …
how long to export, import, storage used
script it. eventually dump data into vite docs

to avoid duplicate downloads from multi host, peek must return a file hash 16/32 bytes. but that must be encrypted to avoid leaking data, which is 40 bytes overhead.

encrypted message header alone allows avoiding download of obsolete records via clk and ctr, but that’s 44bytes for the header plus the 40 bytes for encryption. and requires separately encrypting the body, so 40 additional bytes stored
*/

import { sigBytes, hashBytes, lenBytes } from "../shared/consts.ts";

const kdmBytes = 8;
const eidBytes = 16;
const clkBytes = 8;
const ctrBytes = 4; // Actually a varint.
const metaDataBytes = eidBytes + clkBytes + ctrBytes;
const msgHeaderBytes = kdmBytes + metaDataBytes + lenBytes + hashBytes;

const chachaNonceBytes = 24;
const poly1305TagBytes = 16;
const encryptionOverhead = chachaNonceBytes + poly1305TagBytes;
const statusBytes = 1;

interface IMeasurement {
  design: string;
  comment: string;
  peekPerRecordBytes: number;
  pullPerRecordBytes: number;
  storageOverheadBytes: number;
}

// With MSGHEAD data, client ONLY pulls the latest edit for each entity.
// Incorporate this into scenarios (document editing scenario is high ratio of edits to inserts).
// Produce table column for total bytes pulled (accounts for this savings).
// Add columns for server storage bytes and client storage bytes (full archive, no history, N lookback).
// What if client delta-codes old edits?

interface IScenario {
  scenario: string;
  avgRecordBytes: number;
  editPercent: number; // Edits as percent of total operations.
}
const scenarios: IScenario[] = [
  {
    scenario: "Document Editing",
    avgRecordBytes: 1024 * 1024,
    editPercent: 0.9999,
  },
  {
    scenario: "Productivity App",
    avgRecordBytes: 80,
    editPercent: 0.1,
  },
];

interface IRow extends IMeasurement, IScenario {
  name: string;
  MetaDataBytes: number;
}

const rows: IRow[] = [];
for (const scn of scenarios) {
  rows.push({
    ...scn,
    design: "Envelope-only",
    comment:
      "Does not allow client to avoid downloading redundant messages from multiple hosts.",
    peekOverheadBytes: sigBytes + hashBytes + lenBytes,
    pullOverheadBytes:
      sigBytes + hashBytes + lenBytes + msgHeaderBytes + encryptionOverhead,
  });
  rows.push({
    ...scn,
    design: "Envelope + Encrypted Message Header w/ Body Hash",
    comment: "Body hash allows for deduping.",
    peekOverheadBytes:
      sigBytes + kdmBytes + lenBytes + hashBytes + encryptionOverhead,
    pullOverheadBytes: hashBytes + statusBytes + encryptionOverhead,
  });
}

console.table(
  rows.map((r) => {
    const NumRecords = 1024 * 1024;
    // const NumRecords = 10 * 1024;
    return {
      Scenario: r.scenario,
      Design: r.design,
      AvgRecordBytes: r.avgRecordBytes,
      MetaDataBytes: metaDataBytes,
      PeekOverheadBytes: r.peekOverheadBytes,
      PullOverheadBytes: r.pullOverheadBytes,
      NumRecords,
      EditPercent: r.editPercent,
      TotalPeekBytes: NumRecords * (metaDataBytes + r.peekOverheadBytes),
      TotalDownloadBytes: Number(
        (
          NumRecords *
          (1 - r.editPercent) *
          (metaDataBytes +
            r.peekOverheadBytes +
            r.pullOverheadBytes +
            r.avgRecordBytes)
        ).toFixed(1),
      ),
      FullArchiveBytes:
        NumRecords *
        (metaDataBytes +
          r.peekOverheadBytes +
          r.pullOverheadBytes +
          r.avgRecordBytes),
    };
  }),
  [
    "Scenario",
    "Design",
    "AvgRecordBytes",
    "MetaDataBytes",
    "PeekOverheadBytes",
    "PullOverheadBytes",
    "NumRecords",
    "EditPercent",
    "TotalPeekBytes",
    "TotalDownloadBytes",
    "FullArchiveBytes",
  ],
);
