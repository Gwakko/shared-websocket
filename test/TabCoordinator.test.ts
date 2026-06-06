import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MessageBus } from '../src/MessageBus';
import { TabCoordinator } from '../src/TabCoordinator';

const OPTS = { electionTimeout: 50, leaderTimeout: 1000, leaderPingTimeout: 100, heartbeatInterval: 200 };

function makeTab(id: string) {
  const bus = new MessageBus('coord', id);
  const coord = new TabCoordinator(bus, id, OPTS);
  return { id, bus, coord, dispose: () => { coord[Symbol.dispose](); bus[Symbol.dispose](); } };
}

describe('TabCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a lone tab becomes leader after the election timeout', async () => {
    const a = makeTab('a');
    const p = a.coord.elect();
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(a.coord.isLeader).toBe(true);
    a.dispose();
  });

  it('a second tab becomes a follower (existing leader rejects)', async () => {
    const a = makeTab('a');
    const b = makeTab('b');

    await (async () => { const p = a.coord.elect(); await vi.advanceTimersByTimeAsync(60); await p; })();
    expect(a.coord.isLeader).toBe(true);

    const p = b.coord.elect();
    await vi.advanceTimersByTimeAsync(60);
    await p;
    expect(b.coord.isLeader).toBe(false);
    expect(a.coord.isLeader).toBe(true);

    a.dispose();
    b.dispose();
  });

  it('simultaneous elections converge on ONE leader (split-brain tie-break)', async () => {
    const a = makeTab('a');
    const b = makeTab('b');

    // Both start electing in the same tick — the lower tabId ('a') must win.
    const pa = a.coord.elect();
    const pb = b.coord.elect();
    await vi.advanceTimersByTimeAsync(60);
    await Promise.all([pa, pb]);

    expect(a.coord.isLeader).toBe(true);
    expect(b.coord.isLeader).toBe(false);

    a.dispose();
    b.dispose();
  });

  it('a follower takes over when the leader is unhealthy (no pong)', async () => {
    const a = makeTab('a');
    const b = makeTab('b');

    await (async () => { const p = a.coord.elect(); await vi.advanceTimersByTimeAsync(60); await p; })();
    await (async () => { const p = b.coord.elect(); await vi.advanceTimersByTimeAsync(60); await p; })();
    expect(a.coord.isLeader).toBe(true);
    expect(b.coord.isLeader).toBe(false);

    // Leader's socket is dead → it won't answer health pings.
    a.coord.setHealthCheck(() => false);

    const p = b.coord.verifyLeader();
    await vi.advanceTimersByTimeAsync(120); // ping window lapses → step-down + elect
    await vi.advanceTimersByTimeAsync(60);  // takeover election resolves
    await p;

    expect(b.coord.isLeader).toBe(true);
    expect(a.coord.isLeader).toBe(false); // stepped down

    a.dispose();
    b.dispose();
  });

  it('a follower does NOT take over a healthy leader', async () => {
    const a = makeTab('a');
    const b = makeTab('b');

    await (async () => { const p = a.coord.elect(); await vi.advanceTimersByTimeAsync(60); await p; })();
    await (async () => { const p = b.coord.elect(); await vi.advanceTimersByTimeAsync(60); await p; })();

    a.coord.setHealthCheck(() => true); // healthy → pongs

    const p = b.coord.verifyLeader();
    await vi.advanceTimersByTimeAsync(120);
    await p;

    expect(a.coord.isLeader).toBe(true);
    expect(b.coord.isLeader).toBe(false);

    a.dispose();
    b.dispose();
  });

  it('a leader with a dead socket fires onLeaderUnhealthy (reconnect-in-place)', async () => {
    const a = makeTab('a');
    await (async () => { const p = a.coord.elect(); await vi.advanceTimersByTimeAsync(60); await p; })();

    let unhealthy = 0;
    a.coord.onLeaderUnhealthy(() => unhealthy++);
    a.coord.setHealthCheck(() => false);

    await a.coord.verifyLeader();

    expect(unhealthy).toBe(1);
    expect(a.coord.isLeader).toBe(true); // keeps leadership; owner reconnects

    a.dispose();
  });
});
