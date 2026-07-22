/**
 * Run `fn` over items with at most `concurrency` in flight.
 * Results are returned in input order (not completion order).
 * If `concurrency` < 1, behaves as 1 (serial).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  if (n < 1) return [];
  const out: R[] = new Array(n);
  let next = 0;
  const workers = Math.min(Math.max(1, concurrency), n);
  const run = async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= n) return;
      out[i] = await fn(items[i], i);
    }
  };
  const jobs: Promise<void>[] = [];
  for (let w = 0; w < workers; w++) {
    jobs.push(run());
  }
  await Promise.all(jobs);
  return out;
}
