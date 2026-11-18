/**
 * STOR-UNIT-01: every storage figure follows the file manager of the computer it is shown on. Only the main process
 * can read the platform and `XDG_CURRENT_DESKTOP`, so main works the base out once, the preload reads it
 * synchronously and puts it on the app's bridge, and the renderer sets it before its first render.
 */
import {
  getStorageUnitBase,
  setStorageUnitBase,
  storageUnitBaseFor,
  type StorageUnitBase,
} from "@space/shared/format";

export const STORAGE_UNIT_BASE_CHANNEL = "sf-storage-unit-base";

/** The part of Electron's `ipcMain` the main side uses (no Electron import in this package). */
export type StorageUnitIpcMain = {
  on: (channel: string, listener: (event: { returnValue: unknown }) => void) => unknown;
};

/** The part of Electron's `ipcRenderer` the preload side uses. */
export type StorageUnitIpcRenderer = {
  sendSync: (channel: string) => unknown;
};

const isStorageUnitBase = (value: unknown): value is StorageUnitBase => value === 1000 || value === 1024;

/** Main process: works out this computer's base, logs it once and answers the preload's synchronous read. */
export const serveStorageUnitBase = (
  ipcMain: StorageUnitIpcMain,
  {
    platform,
    desktop,
    log = (line) => console.info(line),
  }: { platform: string; desktop?: string | null; log?: (line: string) => void },
): StorageUnitBase => {
  const base = storageUnitBaseFor(platform, desktop);
  log(`[storage-units] base=${base} platform=${platform} desktop=${desktop || "none"}`);
  ipcMain.on(STORAGE_UNIT_BASE_CHANNEL, (event) => {
    event.returnValue = base;
  });
  return base;
};

/** Preload: the base main worked out, or null when main did not answer (the renderer then keeps its default). */
export const readStorageUnitBase = (ipcRenderer: StorageUnitIpcRenderer): StorageUnitBase | null => {
  try {
    const base = ipcRenderer.sendSync(STORAGE_UNIT_BASE_CHANNEL);
    return isStorageUnitBase(base) ? base : null;
  } catch (error) {
    console.error("[storage-units] base unavailable", error);
    return null;
  }
};

/** Renderer, before the first render: adopts the bridge's base; anything else leaves the default. */
export const applyStorageUnitBase = (base: unknown): StorageUnitBase => {
  if (isStorageUnitBase(base)) setStorageUnitBase(base);
  return getStorageUnitBase();
};
