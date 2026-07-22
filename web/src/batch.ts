/**
 * Split items into request batches by soft byte budget; oversized alone.
 *
 * TODO: async generator instead of materializing all batches up front —
 * minor here, but we should pipeline everything we can for max performance.
 */
export function batchByBytes<T>(
  items: T[],
  sizeOf: (t: T) => number,
  limit: number,
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (batch.length > 0 && bytes + size > limit) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += size;
    if (bytes >= limit) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
