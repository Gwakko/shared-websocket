import { describe, it, expect, afterEach } from 'vitest';
import { PushManager } from '../src/PushManager';
import type { EventHandler, Logger } from '../src/types';

const NOOP_LOG: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Build a PushManager with controllable leader/active state + a manual emitter. */
function harness({ leader, active }: { leader: boolean; active: boolean }) {
  const handlers = new Map<string, EventHandler>();
  const pm = new PushManager({
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    isLeader: () => leader,
    isActive: () => active,
    log: NOOP_LOG,
  });
  const emit = (event: string, data: unknown) => handlers.get(event)?.(data);
  return { pm, emit };
}

class MockNotification {
  static permission = 'granted';
  static requestPermission = () => Promise.resolve('granted');
  static instances: MockNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(public readonly title: string, public readonly options?: unknown) {
    MockNotification.instances.push(this);
  }
}

describe('PushManager — render targeting', () => {
  it('target "active" renders only on a visible tab', () => {
    const visible = harness({ leader: false, active: true });
    let n = 0;
    visible.pm.push('evt', { render: () => n++ }); // default render target = active
    visible.emit('evt', {});
    expect(n).toBe(1);

    const hidden = harness({ leader: true, active: false });
    let m = 0;
    hidden.pm.push('evt', { render: () => m++ });
    hidden.emit('evt', {});
    expect(m).toBe(0);
  });

  it('target "leader" renders only on the leader tab', () => {
    const leader = harness({ leader: true, active: false });
    let n = 0;
    leader.pm.push('evt', { render: () => n++, target: 'leader' });
    leader.emit('evt', {});
    expect(n).toBe(1);

    const follower = harness({ leader: false, active: true });
    let m = 0;
    follower.pm.push('evt', { render: () => m++, target: 'leader' });
    follower.emit('evt', {});
    expect(m).toBe(0);
  });

  it('target "all" renders regardless of role/visibility', () => {
    const h = harness({ leader: false, active: false });
    let n = 0;
    h.pm.push('evt', { render: () => n++, target: 'all' });
    h.emit('evt', {});
    expect(n).toBe(1);
  });

  it('passes the event payload to render and unsubscribes', () => {
    const h = harness({ leader: true, active: true });
    let got: unknown;
    const off = h.pm.push<{ id: number }>('evt', { render: (d) => { got = d; }, target: 'all' });
    h.emit('evt', { id: 7 });
    expect(got).toEqual({ id: 7 });

    got = undefined;
    off();
    h.emit('evt', { id: 8 });
    expect(got).toBeUndefined();
  });
});

describe('PushManager — native notifications', () => {
  afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
    MockNotification.instances = [];
  });

  it('fires a native Notification only when the tab is hidden', () => {
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    // leader + hidden → native fires (default native target = leader)
    const hidden = harness({ leader: true, active: false });
    hidden.pm.push('evt', { title: 'Hi' });
    hidden.emit('evt', {});
    expect(MockNotification.instances.length).toBe(1);

    // leader + visible → no native (native is suppressed while visible)
    MockNotification.instances = [];
    const visible = harness({ leader: true, active: true });
    visible.pm.push('evt', { title: 'Hi' });
    visible.emit('evt', {});
    expect(MockNotification.instances.length).toBe(0);
  });
});
