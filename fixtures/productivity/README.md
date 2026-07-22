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

### Baseline (LPC, in-process; machine-dependent)

| Phase | noble serial | WebCrypto serial | + concurrent peek |
| --- | ---: | ---: | ---: |
| enqueue | ~0.9s | ~2s | ~4s |
| push (LPC) | ~103s | ~94s | ~87s |
| peek (LPC) | ~73s | ~29s | **~9.5s** |
| pull+open+exec | ~4s | ~10s | ~10s |

Peek path: native Ed25519 verify, then concurrent crypto (`defaultPeekConcurrency = 64`). Push is still mostly seal/store. Re-run after architecture changes and compare.
