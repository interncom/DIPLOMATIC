# msg (Message)

A msg is the atomic unit of DIPLOMATIC: an insert, update, or delete of one application object, plus HLC ordering metadata. On the wire and in the archive it carries a complete snapshot of the object's state (not a field patch).

The encoded form is a [message head](../api/push#message-head-data-structure) followed by an optional body.

## Head

| Field | Encoding | Notes |
| ----- | -------- | ----- |
| `typ` | var-string | First so handlers can branch. Empty (0-length) means raw / untyped body. |
| `eid` | var-bytes | Entity id (id + created-at). See [PUSH](../api/push#eid-data-structure). |
| `off` | var-int | Milliseconds since `eid.ts`. |
| `ctr` | var-int | Per-eid update counter. |
| `len` | var-int | Body length. `0` = delete; `hsh` is then omitted. |
| `hsh` | 32 raw bytes | blake3 of the body. Present only when `len > 0`. |

`typ` is positional (not tagged) and first on the wire, so later msg kinds can use a different layout after it. EntDB sets each ent's `type` from this field.

Typical INSERT overhead is [53 bytes](../api/push#message-head-data-structure-overhead) with empty `typ`. A type name adds its UTF-8 length, which is less than the same name as a msgpack `"type"` map entry in the body.

## Body

For EntDB upserts the body is [msgpack](https://msgpack.org) of `{ body, pid?, tags? }`. `type` is not in the body. Deletes have no body.

`insert` / `update` set `typ` from the op's `type`. `insertRaw` / `updateRaw` take an optional `typ` (default empty).

## Archive

The client message store keeps `eid`, `off`, `ctr`, `typ` (omitted when empty), `body`, and apply-lifecycle fields. The archive key is blake3 of the encoded head.
