import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { MockWebSocket } from './mocks/websocket';

/**
 * Visibility-driven recovery. The library wires `visibilitychange` only when
 * `document` exists, so these tests install a document mock. Trick: the leader
 * tab is constructed BEFORE `document` is installed (so it has no listener),
 * and the follower AFTER — so dispatching the event drives only the follower,
 * mirroring "the follower tab is the one the user switched back to".
 */
function makeDocMock() {
  const listeners: Record<string, Set<() => void>> = {};
  return {
    hidden: true,
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= new Set()).add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners[type]?.delete(fn);
    },
    dispatch(type: string) {
      listeners[type]?.forEach((fn) => fn());
    },
  };
}

async function connectAndElect(ws: SharedWebSocket) {
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80);
  await cp;
}

describe('visibility-driven recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete (globalThis as { document?: unknown }).document;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { document?: unknown }).document;
  });

  it('a follower takes over a stale leader when it becomes visible', async () => {
    // Leader built headless → no visibility listener of its own.
    const leader = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connectAndElect(leader);
    const leaderSocket = MockWebSocket.last();
    leaderSocket.open();

    // Install document, then build the follower → only it reacts to the event.
    const doc = makeDocMock();
    (globalThis as { document?: unknown }).document = doc;
    const follower = new SharedWebSocket('wss://x', { electionTimeout: 50, leaderPingTimeout: 100 });
    await connectAndElect(follower);
    expect(follower.tabRole).toBe('follower');

    // Leader's socket silently dies (now reports a non-connected state).
    leaderSocket.serverClose(1006);

    // User switches to the follower tab.
    doc.hidden = false;
    doc.dispatch('visibilitychange');

    await vi.advanceTimersByTimeAsync(150); // ping window lapses (no pong)
    await vi.advanceTimersByTimeAsync(80);  // takeover election resolves

    expect(follower.tabRole).toBe('leader');
    expect(leader.tabRole).toBe('follower');

    leader.disconnect();
    follower.disconnect();
  });

  it('does NOT take over when recoverOnActivate is false', async () => {
    const leader = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connectAndElect(leader);
    const leaderSocket = MockWebSocket.last();
    leaderSocket.open();

    const doc = makeDocMock();
    (globalThis as { document?: unknown }).document = doc;
    const follower = new SharedWebSocket('wss://x', {
      electionTimeout: 50,
      leaderPingTimeout: 100,
      recoverOnActivate: false,
    });
    await connectAndElect(follower);

    leaderSocket.serverClose(1006);
    doc.hidden = false;
    doc.dispatch('visibilitychange');

    // The leader keeps heartbeating (its coordinator is alive), so the
    // staleness path won't fire either within this window.
    await vi.advanceTimersByTimeAsync(300);

    expect(follower.tabRole).toBe('follower');
    expect(leader.tabRole).toBe('leader');

    leader.disconnect();
    follower.disconnect();
  });

  it('reflects visibility via isActive', async () => {
    const doc = makeDocMock();
    doc.hidden = false;
    (globalThis as { document?: unknown }).document = doc;
    const ws = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connectAndElect(ws);

    expect(ws.isActive).toBe(true);
    doc.hidden = true;
    doc.dispatch('visibilitychange');
    expect(ws.isActive).toBe(false);

    ws.disconnect();
  });

  it('catches up a token refresh the throttled timer missed while backgrounded', async () => {
    const doc = makeDocMock();
    doc.hidden = false;
    (globalThis as { document?: unknown }).document = doc;

    let n = 0;
    const ws = new SharedWebSocket('wss://x', {
      electionTimeout: 50,
      refreshTokenInterval: 10_000,
      refresh: () => `tok${++n}`,
    });
    await connectAndElect(ws);
    MockWebSocket.last().open();
    ws.authenticate('tok0');
    await vi.advanceTimersByTimeAsync(5);

    const sock = MockWebSocket.last();
    const logins = () =>
      sock.sent.map((x) => JSON.parse(x as string)).filter((f) => f.event === '$auth:login').length;
    const before = logins();

    // Simulate a backgrounded leader: wall-clock jumps past the refresh
    // interval, but the throttled timer never fires (setSystemTime does not run
    // pending timers). On re-activation the catch-up must refresh.
    vi.setSystemTime(Date.now() + 11_000);
    doc.dispatch('visibilitychange');
    await vi.advanceTimersByTimeAsync(1); // flush the async refresh

    expect(logins()).toBeGreaterThan(before);

    ws.disconnect();
  });
});
