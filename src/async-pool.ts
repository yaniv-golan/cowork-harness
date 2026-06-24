/** Bounded-concurrency async map. Runs `fn` over `items` with at most `concurrency` in flight at once,
 *  preserving result order (results[i] corresponds to items[i]). A worker that throws rejects the whole
 *  pool — callers that want per-item error capture (the batch-record paths do) should make `fn` return a
 *  discriminated result and never throw. `concurrency` is clamped to [1, items.length].
 *
 *  Note on in-process safety: the record setup (egress sidecar, image build) is `spawnSync` — it blocks the
 *  event loop, so the synchronous setup of one item completes before another item's worker can run. Only the
 *  long agent run is async and therefore actually overlaps. That's where the wall-clock win comes from, and
 *  it's also why a cold-start proxy-image build can't race in-process (the first worker builds it synchronously
 *  before yielding). Separate OS processes (`xargs -P`) do NOT get this serialization — see docs/cassette.md. */
export async function pMapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
