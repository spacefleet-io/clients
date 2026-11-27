/** Preload side of the shared desktop updater: the `updater` bridge both apps expose to their window. */
import { UPDATER_CHANNELS, type UpdaterBridge, type UpdaterEvent } from "./types";

/** The part of Electron's `ipcRenderer` the bridge uses (no Electron import in this package). */
export type UpdaterIpcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
  on: (channel: string, listener: (event: unknown, payload: UpdaterEvent) => void) => unknown;
  removeListener: (channel: string, listener: (event: unknown, payload: UpdaterEvent) => void) => unknown;
};

export const createUpdaterBridge = (ipcRenderer: UpdaterIpcRenderer): UpdaterBridge => ({
  check: () => ipcRenderer.invoke(UPDATER_CHANNELS.check),
  downloadUpdate: () => ipcRenderer.invoke(UPDATER_CHANNELS.download),
  installAndRestart: () => ipcRenderer.invoke(UPDATER_CHANNELS.install),
  setAutoUpdate: (enabled) => ipcRenderer.invoke(UPDATER_CHANNELS.setAuto, Boolean(enabled)),
  getState: () => ipcRenderer.invoke(UPDATER_CHANNELS.state),
  onEvent: (listener) => {
    const handler = (_event: unknown, payload: UpdaterEvent) => listener(payload);
    ipcRenderer.on(UPDATER_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(UPDATER_CHANNELS.event, handler);
  },
});
