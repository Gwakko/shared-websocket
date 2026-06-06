import type { EventHandler, Logger, Unsubscribe } from './types';

/** Configuration for `ws.push(event, config)`. */
export interface PushConfig<T = unknown> {
  /** Custom render function — you decide how to display. */
  render?: (data: T) => void;
  /** Title for browser Notification API. */
  title?: string | ((data: T) => string);
  /** Body for browser Notification API. */
  body?: string | ((data: T) => string);
  /** Icon URL for browser Notification. */
  icon?: string;
  /** Tag for browser Notification deduplication. */
  tag?: string | ((data: T) => string);
  /**
   * Which tab(s) show the notification:
   * - `'active'` — only the visible/focused tab (default for render)
   * - `'leader'` — only the leader tab (default for browser Notification)
   * - `'all'` — every tab (critical alerts)
   */
  target?: 'active' | 'leader' | 'all';
  /** Called when browser Notification is clicked. */
  onClick?: (data: T) => void;
}

/** What PushManager needs from its owner. */
export interface PushManagerDeps {
  /** Subscribe to an event (SharedWebSocket.on). */
  on: (event: string, handler: EventHandler) => Unsubscribe;
  isLeader: () => boolean;
  isActive: () => boolean;
  log: Logger;
}

/**
 * Routes incoming events to UI notifications — custom render and/or the browser
 * Notification API — with `target` deciding which tab(s) display them. Extracted
 * from SharedWebSocket so the render-vs-native dispatch lives in one unit.
 */
export class PushManager {
  constructor(private readonly deps: PushManagerDeps) {}

  push<T = unknown>(event: string, config: PushConfig<T>): Unsubscribe {
    const useNativeNotification = !!config.title;

    // Default target: 'active' for render, 'leader' for native.
    const renderTarget = config.target ?? 'active';
    const nativeTarget = config.target ?? 'leader';

    if (useNativeNotification && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    return this.deps.on(event, ((data: unknown) => {
      const typed = data as T;
      const isVisible = this.deps.isActive();
      const isLeader = this.deps.isLeader();

      // Custom render
      if (config.render) {
        const shouldRender =
          renderTarget === 'all' ||
          (renderTarget === 'active' && isVisible) ||
          (renderTarget === 'leader' && isLeader);

        if (shouldRender) {
          config.render(typed);
          this.deps.log.debug('[SharedWS] 🔔 render', event, `(target: ${renderTarget})`);
        }
      }

      // Browser Notification API
      if (useNativeNotification && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const shouldNotify =
          nativeTarget === 'all' ||
          (nativeTarget === 'leader' && isLeader) ||
          (nativeTarget === 'active' && isVisible);

        // Native notifications make sense when the tab is hidden.
        if (shouldNotify && !isVisible) {
          const title = typeof config.title === 'function' ? config.title(typed) : config.title!;
          const body = typeof config.body === 'function' ? config.body(typed) : config.body;
          const tag = typeof config.tag === 'function' ? config.tag(typed) : config.tag;

          const notif = new Notification(title, { body, icon: config.icon, tag });

          if (config.onClick) {
            const handler = config.onClick;
            notif.onclick = () => {
              handler(typed);
              window.focus();
            };
          }

          this.deps.log.debug('[SharedWS] 🔔 native', title, `(target: ${nativeTarget})`);
        }
      }
    }) as EventHandler);
  }
}
