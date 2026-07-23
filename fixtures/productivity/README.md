# Productivity-app sync dataset

Simulated dump matching a real personal productivity workload:

| Metric | Value |
| --- | --- |
| Messages | ~42,000 |
| Entities | ~6,500 |
| Msgs / entity | ~6.5 (avg) |
| Body | `{ type: "todo", body: { text, note?, done } }` (msgpack) |

Used to time LPC sync flows while optimizing the client architecture:

1. **Upload** — enqueue all messages, then `syncPush` over LPC
2. **Download** — `syncPeek` (all heads) then `syncPull` (pull + open + exec)

## Files

- `msgs.msgpack` — packed records (`web/perf/productivity.ts`)
- `meta.json` — counts and size summary

## Regenerate

```bash
bun run web/perf/gen-productivity.ts
```

Smoke-scale (not for committed fixture):

```bash
NUM_ENTS=100 NUM_MSGS=700 bun run web/perf/gen-productivity.ts
```

## Run timings

```bash
bun run web/perf/sync-lpc.ts
# or from web/:
npm run perf:sync
```

**Host** is in-memory LPC (host I/O not the optimization target). **Client** archives use SQLite (bun:sqlite, IDB-like durability):

| DB | Default path | Override |
| --- | --- | --- |
| Uploader client | `fixtures/productivity/client-up-perf.db` | `CLIENT_UP_DB=` |
| Downloader client | `fixtures/productivity/client-down-perf.db` | `CLIENT_DOWN_DB=` |

App EntDB in the harness remains in-memory (state only).

### Baseline (LPC, in-process; machine-dependent)

| Phase | memory client | **SQLite client** (host memory) |
| --- | ---: | ---: |
| enqueue | ~2s | **~14s** |
| push (LPC) | ~66–100s | **~109s** |
| peek (LPC) | ~6–10s | **~13s** |
| pull+open+exec | ~7–12s | **~20s** |

Peek still dominated by concurrent client crypto. Client SQLite shows up on **enqueue**, **push** (`messages.get` + queue), and **pull/open** (archive + download queue). Re-run after architecture changes and compare.
