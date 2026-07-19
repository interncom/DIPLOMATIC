# PULL

The PULL endpoint fetches bag bodies. It takes a list of bag sequence numbers to retrieve.

## Request

### PULL Request Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|authTS|101-104|[see docs](./host#authts-data-structure)|
|seq_1|1-8|var-int|
|seq_...|1-8|var-int|
|seq_N|1-8|var-int|

A 3 byte var-int can encode a number over 1 million, so the typical request weight is 104 bytes plus 3 bytes per bag. A few kilobytes for a request of 1000 bags.

## Host processing

1. Validate `authTS` and that the user is registered.
2. Decode the list of sequence numbers.
3. Fetch bodies with one host storage call, [`getBodies`](./host#getbodies) (batched query; missing seqs omitted).
4. Encode a pull item for each found body.

## Response

The host returns a list of bag pull items for bags that exist. Seq order need not match the request (clients key results by `seq`).

### Bag Pull Item Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|seq|1-8|var-int|
|encrypted bag body|variable|raw bytes|

First, the item provides the `seq` of the bag it is returning, to support streaming responses out-of-order from parallel workers. Again, these `seq` values typically weigh 3 bytes. Then, the encrypted bag body, which has 40 bytes of encryption overhead (see [PUSH](./push) documentation) on top of however many bytes are in the body itself.

A PULL response will typically weigh (43 bytes + average body size) * N, for a PULL request of N bags.
