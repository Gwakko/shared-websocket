import { describe, it, expect } from 'vitest';
import { MessageBus } from '../src/MessageBus';
import { flushMicrotasks } from './mocks/broadcast-channel';

describe('MessageBus', () => {
  it('publish reaches other tabs but not the sender', async () => {
    const a = new MessageBus('chan', 'a');
    const b = new MessageBus('chan', 'b');

    const onA: unknown[] = [];
    const onB: unknown[] = [];
    a.subscribe('topic', (d) => onA.push(d));
    b.subscribe('topic', (d) => onB.push(d));

    a.publish('topic', { v: 1 });
    await flushMicrotasks();

    expect(onB).toEqual([{ v: 1 }]);
    expect(onA).toEqual([]); // never echoes to the publisher

    a[Symbol.dispose]();
    b[Symbol.dispose]();
  });

  it('broadcast self-delivers AND fans out', async () => {
    const a = new MessageBus('chan', 'a');
    const b = new MessageBus('chan', 'b');

    const onA: unknown[] = [];
    const onB: unknown[] = [];
    a.subscribe('topic', (d) => onA.push(d));
    b.subscribe('topic', (d) => onB.push(d));

    a.broadcast('topic', { v: 2 });
    await flushMicrotasks();

    expect(onA).toEqual([{ v: 2 }]); // self-delivered synchronously
    expect(onB).toEqual([{ v: 2 }]);

    a[Symbol.dispose]();
    b[Symbol.dispose]();
  });

  it('request/respond round-trips across tabs', async () => {
    const a = new MessageBus('chan', 'a');
    const b = new MessageBus('chan', 'b');

    b.respond<{ ping: number }, { echo: number }>('q', (d) => ({ echo: d.ping }));

    await expect(a.request('q', { ping: 7 }, 1000)).resolves.toEqual({ echo: 7 });

    a[Symbol.dispose]();
    b[Symbol.dispose]();
  });

  it('respond ignores requests from the same tab', async () => {
    const a = new MessageBus('chan', 'a');
    // Only one tab; it responds to its own topic. A self-request must NOT be
    // answered by its own responder — this is the root of the leader-request
    // bug that SharedWebSocket.request() now works around.
    a.respond('q', () => 'should-not-happen');

    await expect(a.request('q', {}, 200)).rejects.toThrow(/timeout/);

    a[Symbol.dispose]();
  });
});
