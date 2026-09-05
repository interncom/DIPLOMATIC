# PUSH

Clients upload bags to the PUSH endpoint.

## Request

PUSH requests begin with the authTS struct, like all requests. After that, a list of encoded bags. Bags look like this.

### Bag Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|headCph|24 + 16 + encoded head bytes|raw bytes (encrypted with XSalsa20Poly1305Combined)|
|bodyCph|24 + 16 + encoded body bytes|raw bytes (encrypted with XSalsa20Poly1305Combined)|

A bag has a head and a body, headCph and bodyCph (cph short for "cipher"), which are encrypted forms of the message head and body secured within the bag. Both fields in the bag are encrypted with XSalsa20Poly1305Combined, which includes a 24 byte nonce (ChaCha) and a 16 byte tag (Poly1305). The body plaintext is of arbitrary size (determined by the content itself). The message head has structure and predictable size.

### EID Data Structure

Each message has an EID, short for "Entity ID". An entity is an application data object, often abbreviated "ent". The EID specifies which one the message provides a new data state for (including the empty state, which indicates a deletion).

|Field|Bytes|Encoding|
|-----|-----|--------|
|id|variable 1-N|raw bytes|
|ts|variable 6-8|var-date|

There are two components to an EID: `id` and `ts`, which is the timestamp at which the ent was created. We represent the `ts` as a "var-date" which means var-int encoding of milliseconds since the UNIX epoch. Var-dates can encode timestamps in 6 bytes for the next century. By default, the `id` portion is 8 bytes of random data, but it can be anything that distinguishes ents with the same creation time. Compared to a 128-bit random UUID, we save 4 bytes, and additionally encode the creation time, saving another 6 bytes per message.

Typical size: 14 bytes.

### Message Head Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|typ|1+N|var-string|
|eid|2-N (typically 14)|see above|
|off|1-8|var-int milliseconds since eid.ts|
|ctr|1-8 (typically 1)|var-int|
|len|1-8|var-int|
|hsh|32|raw bytes|

The first field is `typ`, a var-string naming the application type (or blob class). It comes first so a decoder can branch on kind before reading the rest of the head — later kinds (e.g. blobs) may use a different layout after `typ`. An empty string (1 byte: length 0) means raw / untyped — a single-type app can skip naming a type. A short name like `"todo"` costs 5 bytes (1 length + 4 UTF-8). EntDB takes the ent's `type` from this field.

Following `typ` comes `eid`, then `off`, the millisecond offset from ent creation time that this message was created. Therefore `eid` and `off` together provide the creation and modification times for a message. Having both these values is generally useful in applications, so Ruby on Rails for instance, adds those columns to every database table. Because the creation and modification times are generally close, we encode the modification time as a delta from creation. This means that the message creating a new ent will encode the creation time with a 6-byte var int, and the offset will be 0, taking a single byte in var-int encoding, for a total cost of 7 bytes. Without this encoding, we would spend 12 bytes or more to encode the two values.

To handle the potential for multiple messages for a single ent in the same millisecond (e.g. high-frequency measurements), the next field is `ctr` an update counter. The client generating a message sets `ctr` to the maximum `ctr` it has observed for this ent, plus 1. This will generally cost 1 byte.

The next fields describe the message contents. `len` is the byte length and `hsh` is the blake3 hash of the message body. A header always includes `len`, but if there is no body, `len` will be 0 and `hsh` is skipped. An empty body indicates that the message deletes the ent. Otherwise, the message is an upsert (insert or update). It is valid for an ent to be upserted after it is deleted.

### Message Head Data Structure Overhead

An INSERT will have `off` and `ctr` of 0, costing 1 byte each. The `eid` will typically be 14 bytes. `hsh` will be 32 (INSERT-ing an empty message makes no sense). And `len` will depend on body size, with 2 bytes sufficient for a 16KB body, and 4 bytes sufficient for 250MB. `typ` costs 1 byte when empty; a non-empty name adds its UTF-8 length (e.g. `"todo"` is 4 more). So a typical INSERT will have a header of 53 bytes, plus the type name if any.

An UPDATE will have higher values for `off` and `ctr`. A single byte will generally suffice for `ctr` (over 100 updates), but 2 bytes would hold 16 thousand. For `off`, 4-6 bytes will capture most values. So we can conservatively estimate an UPDATE header cost as 59 bytes, plus the type name if any.

A DELETE will be an UPDATE, but without the hash, putting the estimated cost as 27 bytes.

|Message Type|Estimated Msg Overhead (bytes)|
|------------|--------------------------|
|INSERT|53|
|UPDATE|59|
|DELETE|27|

Those figures include the 1-byte empty `typ`. A type name adds only its UTF-8 bytes (positional var-string: 1-byte length already counted). That is cheaper than embedding the same name in a [msgpack](https://msgpack.org) body, which is TLV: a map key `"type"` (1 + 4) plus a string value (1 + N) — 10 bytes for `"todo"` vs 5 on the head. For an app that would have encoded a type in the body anyway, total msg size goes down even though the head table went up.

### Bag Data Structure Overhead

Now we can estimate the overhead of a bag (encrypted message). Bags encode the message header and body separately, so that the [PEEK](./peek) request can return headers without bodies, and [PULL](./pull) can return bodies without headers.

Each of those two fields carries an encryption overhead of 40 bytes. Thus the estimated overhead of a bag looks like this.

|Message Type|Estimated Bag Overhead (bytes)|
|------------|--------------------------|
|INSERT|93|
|UPDATE|99|
|DELETE|67|

### PUSH Request Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|authTS|101-104|[see docs](./host#authts-data-structure)|
|bags|see above|see above|

Taking the highest estimate for bag overhead (99 bytes), the estimated weight of a PUSH request is 104 bytes for authTS, plus 99 bytes per bag, plus the weight of each message body.

For a TODO list application, a message like `{ "todo": "take out the trash", done: true }` is a 44 byte JSON string, so the bag overhead os over double the size of the message contents. For this reason, DIPLOMATIC is designed to be prunable. Each message is a complete overwrite of the prior state of the ent. At first glance this may seem wasteful, but the consequence is that correct state of the system can be produced with only the final message for each ent. Clients only need to retain older messages if they want access to historical state, e.g. to support undo. A thin client can immediately discard older messages for an ent upon receiving a new valid one. And if the latest message is a DELETE, the client can discard that one too. This bounds the number of required messages at the size of the "working set" of ents. Even if the message and bag overhead is greater than the size of the message contents, the overhead is fixed-size and thus the data storage requirement of DIPLOMATIC is O(N) where N is the number of messages in the working set.

## Host processing

1. Validate `authTS` and that the user is registered.
2. Decode the bag list. For each bag, verify the signature; invalid signatures get a push item with an error status and are **not** stored.
3. Persist all valid bags with a single host storage call, [`setBags`](./host#setbags), which returns one host `seq` per bag. Implementations batch writes and assign seqs atomically (see host storage docs).
4. Build [NOTF](./notf) items for stored bags and push them to the user's websocket listeners.
5. Return push items for every bag in the request (successes and signature failures).

## Response

The host returns a list of "push items" covering every bag in the request, but not necessarily in the same order. Each push item looks like this.

### Bag Push Item Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|idx|1-8|var-int|
|status|1|var-int|
|seq|1-8|var-int|

The first field is `idx`. This is the index of the bag in the list of uploaded bags. Push items include this index so clients can correlate results when bags are processed out of order. PUSH requests should be chunked by the client (byte and/or item count) so they are not too large for the transport or host. A PUSH with 1,000 bags would have `idx` lengths of 1-2 bytes.

Next is `status`. DIPLOMATIC has a fixed set of numeric status codes. The current set of status codes is less than 127, so fits in a single-byte var-int, but this set may grow until we freeze the protocol.

The final value in the struct is `seq`, an auto-incrementing integer which, together with the user's pubkey, identifies the location of the bag on this particular host. 3 bytes can index over 1 million bags. If a bag was not successfully stored, the `status` code will indicate the error and `seq` will be absent.

A typically PUSH response will typically weigh about 6 bytes per uploaded bag.
