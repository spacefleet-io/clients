/**
 * One ipcRenderer listener per channel, fanned out to any number of renderer
 * subscribers. The player stack subscribes to `sf-mpv-external-message` from up
 * to ~11 places at once (controller, engine, dialog, inline handoff, reload
 * one-shots); one ipc listener each tripped Node's MaxListenersExceededWarning
 * (> 10) even though every subscriber unsubscribed correctly.
 */
// Listener args are `any` to match Electron's `IpcRenderer.on` signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcListener = (event: unknown, ...args: any[]) => void;
type IpcLike = {
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
};

export function createIpcFanout<T>(ipc: IpcLike, channel: string): (callback: (payload: T) => void) => () => void {
  const subscribers = new Set<(payload: T) => void>();
  const dispatch = (_event: unknown, payload: T) => {
    // Snapshot: a subscriber may unsubscribe (or subscribe) while handling.
    for (const callback of [...subscribers]) {
      try {
        callback(payload);
      } catch (error) {
        console.error(`[ipc-fanout] ${channel} subscriber threw`, error);
      }
    }
  };
  return (callback) => {
    // Wrap so the same function subscribed twice still gets two deliveries and two unsubscribes.
    const entry = (payload: T) => callback(payload);
    if (subscribers.size === 0) ipc.on(channel, dispatch as IpcListener);
    subscribers.add(entry);
    return () => {
      if (!subscribers.delete(entry)) return;
      if (subscribers.size === 0) ipc.removeListener(channel, dispatch as IpcListener);
    };
  };
}
