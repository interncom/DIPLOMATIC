# Sync Architecture

Quick sketch. Will document in more detail later.

The DIPLOMATIC protocol achieves eventual consistency.

There are only two types of operation: `UPSERT` and `DELETE`. All operations specify an entity `id` referencing the entity they operate on, and a `timestamp` stating when they were generated, in UTC. DIPLOMATIC tracks the timestamp at which each entity was last altered (feature of the DSL or handled by application? Should probably be DSL).

Processing rules:

- When processing an `UPSERT` or `DELETE` with timestamp predating the timestamp of its target entity, discard that operation. (”Last wins” policy.)
- For other `UPSERT`'s, if the entity doesn’t exist, create it. If it exists, overwrite it.
- For other `DELETE`'s, if the entity exists, delete it. If not, do nothing.

Before DSL sends an operation to the handler, it *must* durably enqueue that operation for upload to a host. If that enqueue fails, it *must* reject the operation without processing it locally. This could cause latency in UI updates, which may be addressed with optimistic UI updates which undo in this (hopefully rare) case. It’s critical to enqueue the upload so that local state does not permanently diverge from synced state.

- [ ]  Spec out how an optional sub-id can allow mutation of parts of complex objects.
