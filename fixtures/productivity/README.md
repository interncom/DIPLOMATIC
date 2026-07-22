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

| Phase | noble Ed25519 | WebCrypto Ed25519 |
| --- | ---: | ---: |
| enqueue | ~0.9s | ~2s |
| push (LPC) | ~103s | ~94s |
| peek (LPC) | ~73s | ~29s |
| pull+open+exec | ~4s | ~10s |

Peek is the clear win: native Ed25519 verify vs pure-JS noble. Push improves only modestly because seal still pays XSalsa20 + blake3 + store work per bag. Re-run after architecture changes and compare.
