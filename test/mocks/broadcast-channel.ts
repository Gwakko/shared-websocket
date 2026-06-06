/**
 * In-memory BroadcastChannel mock for tests.
 *
 * Mirrors the browser semantics the library relies on:
 *  - a message posted on one instance is delivered to OTHER instances on the
 *    same channel name, never to the sender itself;
 *  - delivery is async (queued as a microtask), so it interleaves with timers
 *    the way the real thing does. Drive it from tests with
 *    `await vi.advanceTimersByTimeAsync(...)` or `await flushMicrotasks()`.
 *  - payloads are structured-cloned, so accidentally posting a function or
 *    other non-cloneable value fails here exactly like it would in a browser.
 */
type MessageListener = (ev: { data: unknown }) => void;

const registry = new Map<string, Set<MockBroadcastChannel>>();

export class MockBroadcastChannel {
  onmessage: MessageListener | null = null;
  private closed = false;

  constructor(public readonly name: string) {
    let peers = registry.get(name);
    if (!peers) {
      peers = new Set();
      registry.set(name, peers);
    }
    peers.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const peers = registry.get(this.name);
    if (!peers) return;
    const cloned = structuredClone(data);
    for (const peer of peers) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        if (!peer.closed) peer.onmessage?.({ data: cloned });
      });
    }
  }

  close(): void {
    this.closed = true;
    registry.get(this.name)?.delete(this);
  }
}

/** Forget every channel — call between tests so tabs don't leak across cases. */
export function resetBroadcastChannels(): void {
  registry.clear();
}

/** Let any pending microtask deliveries settle. */
export function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}
