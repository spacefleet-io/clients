/**
 * PreloadMpvClient — renderer-side implementation of {@link MpvClient}.
 *
 * Tier-3 of the @space/mpv-protocol consolidation. Wraps the preload-side
 * bridge (`window.sf.sendExternalMpvCommand` / `sendExternalMpvRequest`)
 * so renderer consumers (engine + controller) can be written against the
 * same `MpvClient` interface as the main-process `UnixSocketMpvClient`.
 *
 * The renderer client owns no resources (the actual socket + process live
 * in the main process), so `dispose()` is a no-op aside from flipping
 * state. Unsubscribing from `observe()` registrations will matter in
 * Tier-4 when push events come online; for now `observe()` throws.
 *
 * The bridge methods on `window.sf` are optional in the preload type
 * because the preload may not be loaded in test/dev environments. We
 * read them at call time and synthesize a `{ error: "no_bridge" }`
 * response when missing — the existing controller-level code already
 * tolerates `null` / sentinel-error responses, so this keeps behavior
 * compatible.
 */

import {
  createTrailingThrottle,
  getProperty as getPropertyHelper,
  isExternalMpvResponseReady,
  buildGetPropertyCommand,
  setProperty as setPropertyHelper,
  type LifecycleState,
  type MpvClient,
  type MpvClientState,
  type MpvCommand,
  type MpvExternalMessage,
  type MpvObserveCallback,
  type MpvObserveOptions,
  type MpvObserveUnsubscribe,
  type MpvProperty,
  type MpvPropertyValue,
  type MpvResponse,
  type SubscribeLifecycleCallback,
  type SubscribeLifecycleUnsubscribe,
} from "@space/mpv-protocol";

const READY_ATTEMPTS = 12;
const READY_BASE_DELAY_MS = 150;
const READY_DELAY_INCREMENT_MS = 25;

const NO_BRIDGE_RESPONSE: MpvResponse = { error: "no_bridge" };

/**
 * Internal subscription shape. Mirrors UnixSocketMpvClient's; mostly
 * boilerplate around the throttle controller (or null).
 */
type ObserveSubscription = {
  property: MpvProperty;
  deliver: (value: unknown) => void;
  throttle: ReturnType<typeof createTrailingThrottle<unknown>> | null;
};

/**
 * Internal shape of the bridge we read from `window.sf`. Methods are
 * optional because the preload may not have mounted by the time a
 * client is constructed (e.g. unit tests, very-early renderer code).
 */
type WindowMpvBridge = {
  sendExternalMpvCommand?: (cmd: MpvCommand) => Promise<MpvResponse>;
  sendExternalMpvRequest?: (cmd: MpvCommand) => Promise<MpvResponse>;
  onMpvExternalMessage?: (
    callback: (msg: MpvExternalMessage) => void,
  ) => () => void;
};

const readBridge = (): WindowMpvBridge | null => {
  if (typeof globalThis === "undefined") return null;
  const win = (globalThis as { window?: { sf?: WindowMpvBridge } }).window;
  return win?.sf ?? null;
};

export class PreloadMpvClient implements MpvClient {
  private _state: MpvClientState = "ready";
  private readyPromise: Promise<boolean> | null = null;
  // Tier-4 — ref-counted property-change subscriptions. The renderer
  // shares ONE listener on `window.sf.onMpvExternalMessage`; that
  // listener dispatches by property name to the registered subscribers.
  private subscriptions = new Map<MpvProperty, ObserveSubscription[]>();
  private messageUnsubscribe: (() => void) | null = null;
  // Tier-5 — local lifecycle snapshot + subscriber set. The snapshot is
  // updated whenever the main-side client emits a `lifecycle` message
  // over `sf-mpv-external-message`. Subscribers are notified immediately
  // on registration with the cached state so `useSyncExternalStore`
  // doesn't see a transient `idle` race when the engine mounts after
  // the first transition has already fired.
  private lifecycleState: LifecycleState = { kind: "idle" };
  private readonly lifecycleSubscribers = new Set<SubscribeLifecycleCallback>();

  get state(): MpvClientState {
    return this._state;
  }

  /**
   * Fire-and-forget command. Returns the bridge's response (which still
   * waits for the main-process ACK — the bridge invokes IPC which calls
   * UnixSocketMpvClient.command in main). `{ error: "no_bridge" }` when
   * the preload is missing.
   */
  async command(cmd: MpvCommand): Promise<MpvResponse> {
    if (this._state === "disposed") return NO_BRIDGE_RESPONSE;
    const bridge = readBridge();
    if (!bridge?.sendExternalMpvCommand) return NO_BRIDGE_RESPONSE;
    try {
      const result = await bridge.sendExternalMpvCommand(cmd);
      return result ?? NO_BRIDGE_RESPONSE;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "command_failed" };
    }
  }

  async request(cmd: MpvCommand): Promise<MpvResponse> {
    if (this._state === "disposed") return NO_BRIDGE_RESPONSE;
    const bridge = readBridge();
    if (!bridge?.sendExternalMpvRequest) return NO_BRIDGE_RESPONSE;
    try {
      const result = await bridge.sendExternalMpvRequest(cmd);
      return result ?? NO_BRIDGE_RESPONSE;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "request_failed" };
    }
  }

  async getProperty<P extends MpvProperty>(
    property: P,
    _signal?: AbortSignal,
  ): Promise<MpvPropertyValue<P> | null> {
    // AbortSignal accepted for forward-compat (Tier-4+); ignored in Tier-3.
    return await getPropertyHelper(this.request.bind(this), property);
  }

  async setProperty<P extends MpvProperty>(
    property: P,
    value: MpvPropertyValue<P>,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    return await setPropertyHelper(this.request.bind(this), property, value);
  }

  /**
   * Subscribe to push events for the given property.
   *
   * Tier-4 — fills in the prior Tier-3 stub. The renderer client doesn't
   * speak to mpv directly; it receives `property_change` messages over
   * the multiplexed `sf-mpv-external-message` IPC channel that the main
   * process forwards from {@link UnixSocketMpvClient}'s persistent event
   * socket.
   *
   * Same ref-counting semantics as the main-side implementation:
   * multiple subscribers per property share the single upstream listener.
   * The first subscription anywhere installs `window.sf.onMpvExternalMessage`;
   * the last unsubscription removes it.
   *
   * `options.throttleMs` wraps the callback in a trailing-throttle. Used
   * by the engine to keep `time-pos` at the same ~250 ms cadence as the
   * prior poll loop, since mpv pushes at decode rate.
   *
   * Returns an unsubscribe function; calling it twice is a no-op.
   */
  observe<P extends MpvProperty>(
    property: P,
    callback: MpvObserveCallback<P>,
    options: MpvObserveOptions = {},
  ): MpvObserveUnsubscribe {
    if (this._state === "disposed") return () => undefined;
    const throttleMs = options.throttleMs ?? 0;
    const typedCallback = callback as (value: unknown) => void;
    const throttle =
      throttleMs > 0
        ? createTrailingThrottle<unknown>(typedCallback, throttleMs)
        : null;
    const deliver: (value: unknown) => void = throttle
      ? throttle.next
      : typedCallback;
    const subscription: ObserveSubscription = { property, deliver, throttle };
    const existing = this.subscriptions.get(property);
    if (existing && existing.length > 0) {
      existing.push(subscription);
    } else {
      this.subscriptions.set(property, [subscription]);
    }
    // Install the upstream listener if it isn't already.
    this.ensureMessageListener();
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      if (subscription.throttle) subscription.throttle.cancel();
      const list = this.subscriptions.get(property);
      if (!list) return;
      const index = list.indexOf(subscription);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) this.subscriptions.delete(property);
      // No subscribers left anywhere — release the upstream listener
      // so the preload bridge doesn't fan out events to a dead client.
      if (this.subscriptions.size === 0 && this.messageUnsubscribe) {
        this.messageUnsubscribe();
        this.messageUnsubscribe = null;
      }
    };
  }

  /**
   * Install the shared `window.sf.onMpvExternalMessage` listener if it
   * isn't already. Idempotent — repeated calls return without doing
   * anything. The listener filters for `type === "property_change"` and
   * `type === "lifecycle"`; both are dispatched to their respective
   * subscriber registries. Other variants (exit, osc_action) are owned
   * by the higher-level components that subscribe directly.
   */
  private ensureMessageListener(): void {
    if (this.messageUnsubscribe) return;
    const bridge = readBridge();
    if (!bridge?.onMpvExternalMessage) return;
    this.messageUnsubscribe = bridge.onMpvExternalMessage((msg) => {
      if (msg.type === "property_change") {
        const subs = this.subscriptions.get(msg.name);
        if (!subs) return;
        for (const sub of subs) {
          try {
            sub.deliver(msg.value);
          } catch {
            // never let a subscriber error tear down the dispatch loop
          }
        }
        return;
      }
      if (msg.type === "lifecycle") {
        this.lifecycleState = msg.state;
        for (const subscriber of this.lifecycleSubscribers) {
          try {
            subscriber(msg.state);
          } catch {
            // ignore — keep the dispatch loop alive even if a subscriber throws
          }
        }
      }
    });
  }

  /**
   * Tier-5 — subscribe to lifecycle state transitions pushed from the
   * main-side `UnixSocketMpvClient` over `sf-mpv-external-message`. The
   * callback fires synchronously with the current cached state on
   * registration (so `useSyncExternalStore` doesn't see a transient
   * `idle` race when the engine mounts mid-launch) and then again on
   * every subsequent transition.
   *
   * Installs the shared message listener on first subscription so the
   * preload bridge starts fanning lifecycle events into this client.
   * Returns an unsubscribe function that is safe to call multiple times.
   */
  subscribeLifecycle(
    callback: SubscribeLifecycleCallback,
  ): SubscribeLifecycleUnsubscribe {
    this.lifecycleSubscribers.add(callback);
    this.ensureMessageListener();
    try {
      callback(this.lifecycleState);
    } catch {
      // never let initial delivery tear down callers
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.lifecycleSubscribers.delete(callback);
    };
  }

  /**
   * 12-attempt time-pos retry with the same 150 + attempt × 25 ms backoff
   * pattern as the main-process client and the engine's
   * `ensureExternalReady`. Idempotent — concurrent callers share the
   * same in-flight promise.
   */
  async waitForReady(timeoutMs: number): Promise<boolean> {
    if (this.readyPromise) return await this.readyPromise;
    this.readyPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
        if (Date.now() >= deadline) break;
        try {
          const result = await this.request(buildGetPropertyCommand("time-pos"));
          if (isExternalMpvResponseReady(result)) {
            return true;
          }
        } catch {
          // wait and retry
        }
        const sleepFor = Math.min(
          READY_BASE_DELAY_MS + attempt * READY_DELAY_INCREMENT_MS,
          Math.max(0, deadline - Date.now()),
        );
        if (sleepFor <= 0) break;
        await new Promise((resolve) => {
          // Prefer the renderer's window.setTimeout (matches engine cadence
          // under jsdom + real DOM); fall back to global setTimeout when
          // absent (e.g. node-only unit harnesses).
          const timeoutHandle =
            typeof globalThis !== "undefined" &&
            (globalThis as { window?: { setTimeout?: typeof setTimeout } }).window?.setTimeout
              ? (globalThis as { window: { setTimeout: typeof setTimeout } }).window.setTimeout
              : setTimeout;
          timeoutHandle(resolve, sleepFor);
        });
      }
      return false;
    })();
    try {
      return await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  /**
   * Renderer-side dispose. The actual mpv process + socket live in the
   * main process and are torn down by UnixSocketMpvClient.dispose(); we
   * only own the local subscription registry + the shared
   * `window.sf.onMpvExternalMessage` listener.
   *
   * Tier-4 — cancels any pending throttled deliveries and drops the
   * upstream listener so the bridge stops fanning events into a
   * disposed client.
   */
  async dispose(): Promise<void> {
    for (const subs of this.subscriptions.values()) {
      for (const sub of subs) {
        if (sub.throttle) sub.throttle.cancel();
      }
    }
    this.subscriptions.clear();
    this.lifecycleSubscribers.clear();
    if (this.messageUnsubscribe) {
      this.messageUnsubscribe();
      this.messageUnsubscribe = null;
    }
    this._state = "disposed";
  }
}

// Module-scope singleton — one PreloadMpvClient per renderer process.
//
// The client caches the latest lifecycle state from main process events
// (`subscribeLifecycle` delivers the cached snapshot synchronously on
// registration, see line ~263). Main does NOT replay past lifecycle events
// for new subscribers — it only emits on actual state transitions. So a
// fresh client constructed AFTER mpv reached `playing` would read the
// initial `{ kind: "idle" }` indefinitely until the next transition fires.
//
// React components that consume the engine via `useMpvPlaybackEngine`
// remount per playback request (e.g. MediaPlaybackController's
// `key={mediaId:requestId}` in MediaDetailsDialog + Dashboard). Pre-fix the
// engine constructed a per-mount client, so a remount mid-launch — or any
// Play click while mpv is still alive — produced an idle-stale snapshot.
// The engine's `isExternalActive(lifecycleRef.current)` gate then
// short-circuited (idle => not active) and re-ran the LAUNCH branch,
// disposing the live mpv and respawning. Manifested as "plays 3 times
// before stabilizing" with `skipping signalPlaybackReady — mpv exited
// during gate` in the renderer log.
//
// The client owns no process resources (mpv lives in main), so sharing one
// instance across mounts is correct. Subscribers are still per-mount (added
// in subscribeLifecycle / observe and removed on the returned unsubscribe).
// The shared upstream `onMpvExternalMessage` listener stays installed for
// as long as at least one subscriber exists.
//
// @bugfix preloadmpvclient-remount-idle-race
let sharedPreloadMpvClient: PreloadMpvClient | null = null;

export const getSharedPreloadMpvClient = (): PreloadMpvClient => {
  if (!sharedPreloadMpvClient) {
    sharedPreloadMpvClient = new PreloadMpvClient();
  }
  return sharedPreloadMpvClient;
};

// Test-only: reset the singleton between unit tests so cached lifecycle
// state from one test doesn't leak into the next. Not exported via the
// package barrel.
export const __resetSharedPreloadMpvClientForTests = (): void => {
  sharedPreloadMpvClient = null;
};
