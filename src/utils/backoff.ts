/** Exponential backoff generator with jitter. */
export function* backoff(base = 1000, max = 30_000): Generator<number> {
  let delay = base;
  while (true) {
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    yield Math.min(delay + jitter, max);
    delay = Math.min(delay * 2, max);
  }
}
