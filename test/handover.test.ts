import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedWebSocket } from '../src/SharedWebSocket';
import { MockWebSocket } from './mocks/websocket';

/**
 * Multi-tab tests for the outbox + leader-handover machinery. Two
 * SharedWebSocket instances share the 'shared-ws' BroadcastChannel (the mock
 * keys by channel name), so one becomes leader and the other a follower.
 */

const frames = (s: MockWebSocket) => s.sent.map((x) => JSON.parse(x as string));

async function makeLeader() {
  const ws = new SharedWebSocket('wss://x', { electionTimeout: 50 });
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80); // win election → become leader → create socket
  await cp;
  const socket = MockWebSocket.last();
  socket.open();
  return { ws, socket };
}

async function makeFollower() {
  // A leader must already exist so this tab is rejected and stays a follower.
  const ws = new SharedWebSocket('wss://x', { electionTimeout: 50 });
  const cp = ws.connect();
  await vi.advanceTimersByTimeAsync(80);
  await cp;
  return ws;
}

/** After the current leader is gone, drive a follower through promotion. */
async function promoteAfterLeaderGone(): Promise<MockWebSocket> {
  await vi.advanceTimersByTimeAsync(80);  // abdicate → election → become leader → create socket
  const socket = MockWebSocket.last();
  socket.open();
  await vi.advanceTimersByTimeAsync(300); // gatherSubscriptions(150) + gatherPending(100) windows
  return socket;
}

describe('outbox & leader handover', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('routes a follower send to the leader socket', async () => {
    const { ws: leader, socket } = await makeLeader();
    const follower = await makeFollower();
    expect(follower.tabRole).toBe('follower');

    follower.send('foo', { n: 1 });
    await vi.advanceTimersByTimeAsync(5); // ws:dispatch → leader transmit → flushed

    expect(frames(socket)).toContainEqual({ event: 'foo', data: { n: 1 } });

    leader.disconnect();
    follower.disconnect();
  });

  it('replays a promoted follower’s channels and topics on the new socket', async () => {
    const { ws: leader } = await makeLeader();
    const follower = await makeFollower();

    // Follower subscribes — frames route to the old leader, and the follower
    // records them locally (channelRefs / topics) for replay on promotion.
    follower.channel('room:1');
    follower.subscribe('topic:a');
    await vi.advanceTimersByTimeAsync(5);

    leader.disconnect(); // leader dies → follower is promoted
    const newSocket = await promoteAfterLeaderGone();

    const sent = frames(newSocket);
    expect(sent).toContainEqual({ event: '$channel:join', data: { channel: 'room:1' } });
    expect(sent).toContainEqual({ event: '$topic:subscribe', data: { topic: 'topic:a' } });

    follower.disconnect();
  });

  it('replays a pending event that never reached a leader', async () => {
    const { ws: leader } = await makeLeader();
    const follower = await makeFollower();

    leader.disconnect();              // leader gone — no socket to flush to
    follower.send('foo', { n: 7 });   // buffered locally (follower, no leader)

    const newSocket = await promoteAfterLeaderGone();

    expect(frames(newSocket)).toContainEqual({ event: 'foo', data: { n: 7 } });

    follower.disconnect();
  });

  it('does NOT replay an event that was already flushed', async () => {
    const { ws: leader, socket } = await makeLeader();
    const follower = await makeFollower();

    follower.send('foo', { n: 1 });
    await vi.advanceTimersByTimeAsync(5); // routed + flushed from the follower buffer
    expect(frames(socket)).toContainEqual({ event: 'foo', data: { n: 1 } });

    leader.disconnect();
    const newSocket = await promoteAfterLeaderGone();

    // The entry was acked, so the new leader must not re-send it (no duplicate).
    expect(frames(newSocket)).not.toContainEqual({ event: 'foo', data: { n: 1 } });

    follower.disconnect();
  });
});
