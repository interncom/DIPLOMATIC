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

## Response

The host queries its database for each of the user's bags with the specified sequence number. It returns a list of bag pull items corresponding to the results of that query.

### Bag Pull Item Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|seq|1-8|var-int|
|encrypted bag body|variable|raw bytes|

First, the item provides the `seq` of the bag it is returning, to support streaming responses out-of-order from parallel workers. Again, these `seq` values typically weigh 3 bytes. Then, the encrypted bag body, which has 40 bytes of encryption overhead (see [PUSH](./push) documentation) on top of however many bytes are in the body itself.

A PULL response will typically weigh (43 bytes + average body size) * N, for a PULL request of N bags.
