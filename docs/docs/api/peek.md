# PEEK

The PEEK endpoint fetches bag headers. It takes one parameter: SEQ, which is the lower-bound (non-inclusive) on host-specific sequence numbers for bags to retrieve.

## Request

### PEEK Request Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|authTS|101-104|[see docs](./host#authts-data-structure)|
|SEQ|1-8|var-int|

Total size: 102-112 bytes.

## Response

The host queries its database for all of the user's bags with sequence number > SEQ. It returns a list of bag peek items corresponding to the results of that query.

### Bag Peek Item Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|seq|1-8|var-int|
|encrypted bag header| |raw bytes|
