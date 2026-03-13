# Use Cases

We can calculate the overhead of DIPLOMATIC in various situations to characterize which use cases it is best for. Here are a few use cases and their characteristics.

1. Personal productivity app (e.g. todo list, contacts, calendar). Moderate number of entities. Continuously growing. Less than 1kb in size each. Low edit ratio (edits per entity).
2. IoT measurement recording. Very large number of entites. Zero updates.
3. Media library (e.g. photos, music). Thousands of entities. Megabytes in size. Zero updates. Some deletes.
4. Document editor. Single entity. Large number of updates.

## Productivity App

Our model of a personal productivity app will have a user taking maybe 50 actions per day in the app, each generating a msg. We'll assume half are INSERTs and half are UPDATEs (e.g. creating a todo and then checking it off as complete). The actions will have some object structure. For a todo app, it might look like `{ todo: "Get groceries", done: false, deadline: undefined }`. Call it roughly 50-250 bytes of content data per action.

In DIPLOMATIC, an INSERT msg has [52 bytes of overhead](../api/push#message-head-data-structure-overhead) and an UPDATE has 58 bytes of overhead. So with our assumed 50/50 split, we can call the overhead 55 bytes on average. This is about the bottom end of our assumed content size range. So the overhead is 50% or less.

This is the main case DIPLOMATIC has been designed for.

## IoT

In an IoT data collection setting, there will be many INSERTs an no UPDATEs or DELETEs. The size of the collected data samples will vary based on the detector, but let's assume 8 bytes for a single numeric measurement. 

In DIPLOMATIC, an INSERT msg has [52 bytes of overhead](../api/push#message-head-data-structure-overhead). With a total msg size of 60 bytes, the overhead will be almost 90%. If securely relaying the data is important, DIPLOMATIC may be a fit. But if space-efficiency matters, you probably want a different solution with lower overhead for this use case.

## Media Library

A media library stores immutable files. One insert per file. No updates. Take an example photo library of 25k photos, each 4mb in size. This is 100gb of raw data.

In DIPLOMATIC, an INSERT msg has [52 bytes of overhead](../api/push#message-head-data-structure-overhead). Multiplied by 25,000, that is about 1mb of total overhead. Completely negligible compared to the data set size. Fraction of a fraction of a percent.

## Editor

This is the worst case for DIPLOMATIC: a very high ratio of updates to inserts. Imagine a text editor where each keystroke results in a new msg updating the single document ent. This would yield a series of msgs of monotonically increasing size. Slightly better would be to batch updates. But this is a problem that has been solved many times. If you're building a text editor you may want a different solution than DIPLOMATIC.
