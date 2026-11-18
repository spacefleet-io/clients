/**
 * JS half of the Android keep-alive (`JsKeepAlive.kt`, PLAY-OSMEDIA-01 item 4): while the card plays, and for a short
 * while after a card or headset press, the native module runs this headless JS task so React Native keeps JS timers
 * running with the app in the background or the screen locked. The task only waits: it ends when the native side
 * sends `KEEP_ALIVE_END_EVENT` with the task's token. Pure: the event source is passed in, so tests run without React
 * Native.
 */
export const KEEP_ALIVE_TASK = "SpaceMediaSessionKeepAlive";
export const KEEP_ALIVE_END_EVENT = "SpaceMediaSessionKeepAliveEnd";

export type KeepAliveData = { token?: number };

export type KeepAliveEvents = {
  addListener: (eventName: string, listener: (event: KeepAliveData) => void) => { remove: () => void };
};

/** The headless task: resolves once the native side ends the keep-alive that started it. */
export const createKeepAliveTask =
  (events: KeepAliveEvents, log: (message: string, detail?: Record<string, unknown>) => void = () => undefined) =>
  (data: KeepAliveData): Promise<void> =>
    // Executor form: the app's runtime code does not rely on `Promise.withResolvers` under Hermes.
    new Promise((resolve) => {
      log("media_session.keep_alive_task_start", { token: data?.token });
      const subscription = events.addListener(KEEP_ALIVE_END_EVENT, (event) => {
        if (event?.token !== data?.token) return;
        subscription.remove();
        log("media_session.keep_alive_task_end", { token: data?.token });
        resolve();
      });
    });
