import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { MockWebSocket } from './mocks/websocket';

const frames = (s: MockWebSocket) => s.sent.map((x) => JSON.parse(x as string));

async function makeLeader(options = {}) {
  const ws = new SharedWebSocket('wss://x', { electionTimeout: 50, ...options });
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80);
  await cp;
  MockWebSocket.last().open();
  return ws;
}

async function makeFollower() {
  const ws = new SharedWebSocket('wss://x', { electionTimeout: 50 });
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80);
  await cp;
  return ws;
}

describe('AuthManager (via SharedWebSocket)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('authenticate sends auth-login and flips state + onAuthChange', async () => {
    const ws = await makeLeader();
    const changes: unknown[] = [];
    ws.onAuthChange((a) => changes.push(a));

    ws.authenticate('tok1');
    await vi.advanceTimersByTimeAsync(5);

    expect(ws.isAuthenticated).toBe(true);
    expect(changes).toContain(true);
    expect(frames(MockWebSocket.last())).toContainEqual({ event: '$auth:login', data: { token: 'tok1' } });

    ws.disconnect();
  });

  it('deauthenticate sends auth-logout and clears state', async () => {
    const ws = await makeLeader();
    ws.authenticate('tok1');
    await vi.advanceTimersByTimeAsync(5);
    const changes: unknown[] = [];
    ws.onAuthChange((a) => changes.push(a));

    ws.deauthenticate();
    await vi.advanceTimersByTimeAsync(5);

    expect(ws.isAuthenticated).toBe(false);
    expect(changes).toContain(false);
    expect(frames(MockWebSocket.last())).toContainEqual({ event: '$auth:logout', data: {} });

    ws.disconnect();
  });

  it('syncs auth state across tabs', async () => {
    const leader = await makeLeader();
    const follower = await makeFollower();
    const changes: unknown[] = [];
    follower.onAuthChange((a) => changes.push(a));

    leader.authenticate('tok');
    await vi.advanceTimersByTimeAsync(5);

    expect(follower.isAuthenticated).toBe(true);
    expect(changes).toContain(true);

    leader.disconnect();
    follower.disconnect();
  });

  it('re-sends auth-login on reconnect', async () => {
    const ws = await makeLeader();
    ws.authenticate('tok');
    await vi.advanceTimersByTimeAsync(5);
    const dead = MockWebSocket.last();

    dead.serverClose(1006);              // abnormal close → auto-reconnect
    await vi.advanceTimersByTimeAsync(2000); // backoff elapses → fresh socket
    const fresh = MockWebSocket.last();
    expect(fresh).not.toBe(dead);
    fresh.open();
    await vi.advanceTimersByTimeAsync(300); // onConnected: reauthenticate + replays

    expect(frames(fresh)).toContainEqual({ event: '$auth:login', data: { token: 'tok' } });

    ws.disconnect();
  });

  it('clears auth on server revocation', async () => {
    const ws = await makeLeader();
    ws.authenticate('tok');
    await vi.advanceTimersByTimeAsync(5);
    const changes: unknown[] = [];
    ws.onAuthChange((a) => changes.push(a));

    // Server pushes the revocation event over the socket.
    MockWebSocket.last().emit(JSON.stringify({ event: '$auth:revoked', data: {} }));
    await vi.advanceTimersByTimeAsync(5);

    expect(ws.isAuthenticated).toBe(false);
    expect(changes).toContain(false);

    ws.disconnect();
  });

  it('leader refreshes the token on interval', async () => {
    let n = 0;
    const ws = await makeLeader({ refreshTokenInterval: 1000, refresh: () => `tok${++n}` });
    ws.authenticate('tok0');
    await vi.advanceTimersByTimeAsync(5);
    const sock = MockWebSocket.last();
    const before = frames(sock).filter((f) => f.event === '$auth:login').length;

    await vi.advanceTimersByTimeAsync(1000); // refresh timer fires → re-authenticate
    await vi.advanceTimersByTimeAsync(5);

    const after = frames(sock).filter((f) => f.event === '$auth:login').length;
    expect(after).toBeGreaterThan(before);

    ws.disconnect();
  });
});
