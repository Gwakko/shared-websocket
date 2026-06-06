import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { MockWebSocket } from './mocks/websocket';

/** Minimal window mock exposing add/removeEventListener + a dispatch driver. */
function makeWindowMock() {
  const listeners: Record<string, Set<(e: unknown) => void>> = {};
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      (listeners[type] ??= new Set()).add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners[type]?.delete(fn);
    },
    dispatch(type: string, event: unknown) {
      listeners[type]?.forEach((fn) => fn(event));
    },
  };
}

async function connect(ws: SharedWebSocket) {
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80);
  await cp;
}

describe('page lifecycle (pagehide / pageshow)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { window?: unknown }).window = makeWindowMock();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
  });

  const win = () => (globalThis as { window: ReturnType<typeof makeWindowMock> }).window;

  it('a leader entering bfcache abdicates so another tab takes over', async () => {
    const leader = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connect(leader);
    MockWebSocket.last().open();

    const follower = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connect(follower);

    expect(leader.tabRole).toBe('leader');
    expect(follower.tabRole).toBe('follower');

    win().dispatch('pagehide', { persisted: true }); // leader → bfcache
    await vi.advanceTimersByTimeAsync(80); // follower elects on coord:abdicate

    expect(follower.tabRole).toBe('leader');
    expect(leader.tabRole).toBe('follower');

    leader.disconnect();
    follower.disconnect();
  });

  it('a single leader re-elects when restored from bfcache', async () => {
    const ws = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connect(ws);
    MockWebSocket.last().open();
    expect(ws.tabRole).toBe('leader');

    win().dispatch('pagehide', { persisted: true });
    expect(ws.tabRole).toBe('follower'); // relinquished, not torn down

    win().dispatch('pageshow', { persisted: true });
    await vi.advanceTimersByTimeAsync(80); // re-election

    expect(ws.tabRole).toBe('leader');

    ws.disconnect();
  });

  it('a real unload tears the socket down', async () => {
    const ws = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connect(ws);
    const sock = MockWebSocket.last();
    sock.open();
    expect(sock.readyState).toBe(MockWebSocket.OPEN);

    win().dispatch('pagehide', { persisted: false }); // real navigation/close

    expect(sock.readyState).toBe(MockWebSocket.CLOSED);
  });
});
