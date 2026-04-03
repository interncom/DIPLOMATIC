# Benchmarks

## Bag Seal/Open

A bag is the encrypted form of a message. Sealing a bag is encrypting the message. Opening a bag is decrypting it.

```
CPU | Intel(R) Core(TM) i5-6300U CPU @ 2.40GHz
Runtime | Deno 2.7.4 (x86_64-unknown-linux-gnu)

| benchmark          | time/iter (avg) |        iter/s |      (min … max)      |      p75 |      p99 |     p995 |
| ------------------ | --------------- | ------------- | --------------------- | -------- | -------- | -------- |
| seal bag (16b)     |        226.1 µs |         4,423 | (133.9 µs …   1.3 ms) | 245.1 µs | 834.1 µs | 881.9 µs |
| open bag (16b)     |        251.2 µs |         3,980 | (201.2 µs … 748.8 µs) | 261.6 µs | 531.8 µs | 604.8 µs |
| seal bag (512b)    |        221.2 µs |         4,521 | (144.9 µs …   1.4 ms) | 242.9 µs | 802.8 µs | 842.2 µs |
| open bag (512b)    |        257.1 µs |         3,890 | (213.0 µs …   1.2 ms) | 267.6 µs | 508.3 µs | 636.4 µs |
| seal bag (1kb)     |        226.7 µs |         4,411 | (159.2 µs …   1.0 ms) | 243.6 µs | 731.8 µs | 787.8 µs |
| open bag (1kb)     |        279.4 µs |         3,580 | (229.6 µs … 997.9 µs) | 282.6 µs | 560.6 µs | 630.6 µs |
| seal bag (16kb)    |        872.2 µs |         1,147 | (639.7 µs …   2.1 ms) | 982.4 µs |   1.6 ms |   1.9 ms |
| open bag (16kb)    |        913.9 µs |         1,094 | (708.0 µs …   2.0 ms) | 998.0 µs |   1.6 ms |   1.8 ms |
| seal bag (128kb)   |          5.8 ms |         172.8 | (  4.9 ms …   8.2 ms) |   6.2 ms |   8.2 ms |   8.2 ms |
| open bag (128kb)   |          5.7 ms |         174.8 | (  4.6 ms …   9.1 ms) |   6.1 ms |   9.1 ms |   9.1 ms |
| seal bag (1mb)     |         42.6 ms |          23.5 | ( 38.7 ms …  55.9 ms) |  43.3 ms |  55.9 ms |  55.9 ms |
| open bag (1mb)     |         42.2 ms |          23.7 | ( 37.9 ms …  51.4 ms) |  42.8 ms |  51.4 ms |  51.4 ms |
| seal bag (5mb)     |        218.1 ms |           4.6 | (198.4 ms … 258.0 ms) | 222.9 ms | 258.0 ms | 258.0 ms |
| open bag (5mb)     |        214.0 ms |           4.7 | (194.4 ms … 246.5 ms) | 225.1 ms | 246.5 ms | 246.5 ms |
```
