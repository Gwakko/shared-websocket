import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { MockWebSocket } from './mocks/websocket';

/** Reach the private coordinator to drive a takeover from the test. */
function coordinatorOf(ws: SharedWebSocket) {
  return (ws as unknown as { coordinator: { verifyLeader(): Promise<void> } }).coordinator;
}

async function connectAndElect(ws: SharedWebSocket) {
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80);
  await cp;
}

describe('ws:request responder teardown on demotion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a demoted leader stops answering requests (no stale responder)', async () => {
    const ws1 = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connectAndElect(ws1);
    const socketA = MockWebSocket.last();
    socketA.open();

    const ws2 = new SharedWebSocket('wss://x', { electionTimeout: 50, leaderPingTimeout: 100 });
    await connectAndElect(ws2);

    const ws3 = new SharedWebSocket('wss://x', { electionTimeout: 50 });
    await connectAndElect(ws3);

    expect(ws2.tabRole).toBe('follower');
    expect(ws3.tabRole).toBe('follower');

    // ws1's socket dies; ws2 takes over → ws1 is demoted to a follower.
    socketA.serverClose(1006);
    const takeover = coordinatorOf(ws2).verifyLeader();
    await vi.advanceTimersByTimeAsync(150); // ping window
    await vi.advanceTimersByTimeAsync(80);  // takeover election
    await takeover;

    expect(ws2.tabRole).toBe('leader');
    expect(ws1.tabRole).toBe('follower');

    const socketB = MockWebSocket.last(); // ws2's fresh leader socket
    socketB.open();

    // A follower issues a request. Only the real leader (ws2) may answer it.
    // If the demoted ws1 still held its responder, it would post `undefined`
    // first (it has no socket) and the requester would resolve to the wrong
    // value before the real answer arrived.
    const p = ws3.request<{ ok: boolean }>('foo', { x: 1 }, 1000);
    await vi.advanceTimersByTimeAsync(5); // a stale responder would resolve here
    socketB.emit(JSON.stringify({ event: 'foo', data: { ok: true } }));

    await expect(p).resolves.toEqual({ ok: true });

    ws1.disconnect();
    ws2.disconnect();
    ws3.disconnect();
  });

  it('requests transmit exactly once across leadership churn', async () => {
    const ws1 = new SharedWebSocket('wss://x', { electionTimeout: 50, leaderPingTimeout: 100 });
    await connectAndElect(ws1);
    MockWebSocket.last().open();

    const ws2 = new SharedWebSocket('wss://x', { electionTimeout: 50, leaderPingTimeout: 100 });
    await connectAndElect(ws2);

    // Hand leadership ws1 → ws2 ...
    const sA = MockWebSocket.instances[0];
    sA.serverClose(1006);
    let t = coordinatorOf(ws2).verifyLeader();
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(80);
    await t;
    const sB = MockWebSocket.last();
    sB.open();
    expect(ws2.tabRole).toBe('leader');

    // ... then back ws2 → ws1.
    sB.serverClose(1006);
    t = coordinatorOf(ws1).verifyLeader();
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(80);
    await t;
    const sC = MockWebSocket.last();
    sC.open();
    expect(ws1.tabRole).toBe('leader');

    // ws2 (now follower) requests; ws1 (leader) must transmit it exactly once.
    const p = ws2.request('foo', { x: 1 }, 1000);
    await vi.advanceTimersByTimeAsync(5);
    const fooFrames = sC.sent
      .map((x) => JSON.parse(x as string))
      .filter((f) => f.event === 'foo');
    expect(fooFrames.length).toBe(1);
    sC.emit(JSON.stringify({ event: 'foo', data: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });

    ws1.disconnect();
    ws2.disconnect();
  });
});
