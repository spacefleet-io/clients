// @req STOR-UNIT-01[badger-desktop,parrot]
// The bridge Badger and Parrot desktop share: main works the base out from the platform and
// XDG_CURRENT_DESKTOP, the preload reads it synchronously, the renderer sets it before its first render.
import { afterEach, describe, expect, it } from "vitest";
import { formatStorageBytes, getStorageUnitBase, setStorageUnitBase } from "@space/shared/format";
import {
  STORAGE_UNIT_BASE_CHANNEL,
  applyStorageUnitBase,
  readStorageUnitBase,
  serveStorageUnitBase,
} from "../src/storageUnits";

/** A stand-in for Electron's ipcMain + ipcRenderer pair: `sendSync` runs main's listener and returns `returnValue`. */
const fakeIpc = () => {
  const listeners = new Map<string, (event: { returnValue: unknown }) => void>();
  return {
    ipcMain: {
      on: (channel: string, listener: (event: { returnValue: unknown }) => void) => listeners.set(channel, listener),
    },
    ipcRenderer: {
      sendSync: (channel: string) => {
        const listener = listeners.get(channel);
        if (!listener) throw new Error(`no listener on ${channel}`);
        const event = { returnValue: undefined as unknown };
        listener(event);
        return event.returnValue;
      },
    },
  };
};

afterEach(() => {
  setStorageUnitBase(1000);
});

describe("desktop storage unit bridge (STOR-UNIT-01)", () => {
  it.each([
    { platform: "win32", desktop: undefined, want: 1024, gb: "5.0 GB" },
    { platform: "linux", desktop: "KDE", want: 1024, gb: "5.0 GB" },
    { platform: "darwin", desktop: undefined, want: 1000, gb: "5.4 GB" },
    { platform: "linux", desktop: "ubuntu:GNOME", want: 1000, gb: "5.4 GB" },
  ])("the renderer picks $want on $platform ($desktop)", ({ platform, desktop, want, gb }) => {
    const { ipcMain, ipcRenderer } = fakeIpc();
    const logged: string[] = [];
    // Start the renderer on the other base so the test proves the bridge moved it.
    setStorageUnitBase(want === 1024 ? 1000 : 1024);

    const served = serveStorageUnitBase(ipcMain, { platform, desktop, log: (line) => logged.push(line) });
    const fromPreload = readStorageUnitBase(ipcRenderer);
    const applied = applyStorageUnitBase(fromPreload);
    const shown = formatStorageBytes(5 * 1024 ** 3);
    console.info("[STOR-UNIT-BRIDGE-001]", { platform, desktop, served, fromPreload, applied, shown, logged });

    expect(served).toBe(want);
    expect(fromPreload).toBe(want);
    expect(applied).toBe(want);
    expect(getStorageUnitBase()).toBe(want);
    expect(shown).toBe(gb);
    expect(logged).toEqual([`[storage-units] base=${want} platform=${platform} desktop=${desktop ?? "none"}`]);
  });

  it("keeps the renderer's default when main did not answer", () => {
    const { ipcRenderer } = fakeIpc();
    const fromPreload = readStorageUnitBase(ipcRenderer);
    const applied = applyStorageUnitBase(fromPreload);
    console.info("[STOR-UNIT-BRIDGE-002]", { channel: STORAGE_UNIT_BASE_CHANNEL, fromPreload, applied });
    expect(fromPreload).toBeNull();
    expect(applied).toBe(1000);
  });
});
