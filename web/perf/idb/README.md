# IndexedDB key encoding bench

Browser harness comparing how binary IDs perform as IndexedDB keys under several
encodings, with an **EntDB-shaped** workload (inline `eid`, optional `pid`,
`typ`+`pid` / `typ`+`crd` indexes, small body).

## Run

From `web/`:

```bash
npm run perf:idb
```

Open http://localhost:4177/ (not `file://`).

## Defaults

| Param | Default | Why |
|---|---|---|
| N | 100 000 | large apply/list scale |
| EID bytes | **14** | typical DIPLOMATIC EID (8 random + 6 date) |
| Point sample | 1000 | single-entity loads |

## Metrics

| Column | Maps to |
|---|---|
| encode/decode eid+pid | `entityToStored` / `storedToEntity` |
| insert/apply | bulk `put` in one tx |
| point | `get(eid)` + decode |
| list-by-pid | index `["typ","pid"]` `getAll` |
| type scan | index `["typ","crd"]` range |
| getAll | full store (export-ish) |

## Encodings

binary (no-op), base64, base64u, base128, hex, latin1 — see page notes for
latin1 vs true binary size.
