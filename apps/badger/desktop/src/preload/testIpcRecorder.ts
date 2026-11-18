// Test-only IPC chatter recorder. When SF_E2E === "1" we wrap ipcRenderer.invoke,
// ipcRenderer.send, and ipcRenderer.on so every cross-process message becomes a
// timestamped entry in a capped in-memory ring buffer. The buffer is exposed to
// the renderer via `window.__e2eIpcRecorder` so Playwright tests can read it
// through `page.evaluate` and assert on IPC volume per channel.
//
// When SF_E2E !== "1" this module is a strict no-op: no wrapping, no listener
// instrumentation, no global is exposed. Production behavior is untouched.
//
// Errors thrown by the underlying ipcRenderer methods are NOT swallowed —
// the wrappers record-then-rethrow so test code never observes false success.
import type { IpcRenderer, IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer } from "electron";

type IpcRecorderKind = "invoke" | "send" | "receive";

type IpcRecorderEntry = {
  ts: number;
  kind: IpcRecorderKind;
  channel: string;
};

const RING_BUFFER_CAP = 5000;

const isE2EEnabled = () => process.env.SF_E2E === "1";

const installRecorder = () => {
  const entries: IpcRecorderEntry[] = [];

  const record = (kind: IpcRecorderKind, channel: string) => {
    entries.push({ ts: Date.now(), kind, channel });
    if (entries.length > RING_BUFFER_CAP) {
      // Drop oldest entries — preserves the most recent activity while bounding memory.
      entries.splice(0, entries.length - RING_BUFFER_CAP);
    }
  };

  const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
  const originalSend = ipcRenderer.send.bind(ipcRenderer);
  const originalOn = ipcRenderer.on.bind(ipcRenderer);
  const originalRemoveListener = ipcRenderer.removeListener.bind(ipcRenderer);

  // channel -> original listener -> wrappers still registered (a listener
  // added N times has N wrappers, removed one per call like EventEmitter).
  // @bugfix @regression-proof issue #25 P6: the wrapper used to be untracked,
  // so `removeListener(channel, original)` found nothing and EVERY renderer
  // unsubscribe was a silent no-op under SF_E2E=1. Stale mpv-exit listeners
  // then flushed old positions over the resume point (741 flushProgress
  // calls on one exit in the ultimate run).
  type Listener = (event: IpcRendererEvent, ...args: unknown[]) => void;
  const wrappersByChannel = new Map<string, Map<Listener, Listener[]>>();

  // Wrap invoke. Errors are recorded as the call (kind: "invoke") and rethrown.
  const wrappedInvoke: IpcRenderer["invoke"] = (channel: string, ...args: unknown[]) => {
    record("invoke", channel);
    return originalInvoke(channel, ...args);
  };

  const wrappedSend: IpcRenderer["send"] = (channel: string, ...args: unknown[]) => {
    record("send", channel);
    return originalSend(channel, ...args);
  };

  const wrappedOn: IpcRenderer["on"] = (channel: string, listener: Listener) => {
    const wrappedListener: Listener = (event, ...args) => {
      record("receive", channel);
      listener(event, ...args);
    };
    let byListener = wrappersByChannel.get(channel);
    if (!byListener) {
      byListener = new Map();
      wrappersByChannel.set(channel, byListener);
    }
    byListener.set(listener, [...(byListener.get(listener) ?? []), wrappedListener]);
    return originalOn(channel, wrappedListener);
  };

  const wrappedRemoveListener: IpcRenderer["removeListener"] = (channel: string, listener: Listener) => {
    const byListener = wrappersByChannel.get(channel);
    const wrappers = byListener?.get(listener);
    const wrapper = wrappers?.pop();
    if (byListener && wrappers && wrappers.length === 0) byListener.delete(listener);
    // Unknown listener (registered via once/addListener, or never wrapped):
    // fall through with the original so EventEmitter semantics are unchanged.
    return originalRemoveListener(channel, wrapper ?? listener);
  };

  // Patch the live ipcRenderer so all callers in this preload context see the
  // wrapped versions, regardless of when they captured the reference.
  (ipcRenderer as unknown as { invoke: IpcRenderer["invoke"] }).invoke = wrappedInvoke;
  (ipcRenderer as unknown as { send: IpcRenderer["send"] }).send = wrappedSend;
  (ipcRenderer as unknown as { on: IpcRenderer["on"] }).on = wrappedOn;
  (ipcRenderer as unknown as { removeListener: IpcRenderer["removeListener"] }).removeListener = wrappedRemoveListener;
  (ipcRenderer as unknown as { off: IpcRenderer["off"] }).off = wrappedRemoveListener;

  contextBridge.exposeInMainWorld("__e2eIpcRecorder", {
    read: (): IpcRecorderEntry[] => entries.slice(),
    reset: () => {
      entries.length = 0;
    },
  });
};

export const initTestIpcRecorder = () => {
  if (!isE2EEnabled()) return;
  installRecorder();
};

export type { IpcRecorderEntry, IpcRecorderKind };
