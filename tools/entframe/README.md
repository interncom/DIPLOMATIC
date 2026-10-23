# Ent frame

Rewrites a pre-v0.24 DIPLOMATIC export (`.dpl`) onto the v0.24 ent body.

The old message body is msgpack `{ body, pid?, tags?, type? }`. The new body
is the ent frame: `pid`, tags, then the application `body` still encoded with
msgpack. `type` is copied onto the head when the head `typ` is empty. A body
that is already a frame is left unchanged. Null `gid`, `pid`, and `tags` are
absent, and an empty map becomes an empty ent. A `gid` with any other value,
or any other extra key, rejects the file. Run that app migration first.

Before writing, the tool checksums eid, off, ctr, type, pid, tags, and the
application payload. The digest is the same for the old bodies and the frames.
`len` and the body hash are not in it. A mismatch refuses the write. The
digest is printed on stderr.

Unlock uses `~/.diplomatic/<LABEL>` via `tools/keys`, same as rekey. LABEL is
which master to unseal. The file nonce is in the header. The tool re-seals under that same nonce.

```
bun run entframe.ts LIFE export.dpl framed.dpl
bun run entframe.ts LIFE export.dpl > framed.dpl
```

Run from this directory. Progress is on stderr, so a stdout redirect works.
