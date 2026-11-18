// @req ACCT-PAIR-03[badger-mobile] @bugfix @regression-proof
// Exploratory walk on the OnePlus 6 (2026-11-12): "Nouvel appareil ajouté" said "Tap to see your devices", but tapping
// it only opened Settings where it was last scrolled (the Language section). Tapping the notice (or the notification)
// must open "Your devices" with the list open.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenDevices, type OpenDevices } from "../src/lib/pairing/useOpenDevices";
import { DevicesSection } from "../src/components/DevicesSection";

const ctl = vi.hoisted(() => ({ sheetOpens: 0 }));
const TAG = "[open-devices]";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  Alert: { alert: () => undefined },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock("../src/components/usePickerSheet", () => {
  const open = () => {
    ctl.sheetOpens += 1;
  };
  return { usePickerSheet: () => ({ visible: false, open, close: () => undefined, closed: () => undefined }) };
});
// The shared sheet's drags load gesture-handler's native code; the device list renders without it.
vi.mock("@space/mobile-shell/bottom-sheet", () => ({
  MobileBottomSheet: () => null,
  MobileSheetScrollView: "ScrollView",
  useMobileSheetClose: () => (after?: () => void) => after?.(),
}));
vi.mock("@space/mobile-shell/i18n", () => {
  const t = (key: string) => key;
  return { translate: t, getCurrentLanguage: () => "en", useTranslation: () => ({ t }) };
});
vi.mock("@space/mobile-shell/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  return { useMobileShellTheme: () => ({ colors }) };
});
vi.mock("../src/components/BottomSheet", () => ({ BottomSheet: () => null }));
vi.mock("../src/components/ui", () => ({ Button: "Button", Card: "Card" }));
vi.mock("@space/shared/api", () => ({ listDevices: async () => ({ sessions: [] }), revokeDevice: async () => undefined }));
vi.mock("@space/mobile-shell/pairing-approve", () => ({
  deviceTypeLabel: (type: string | null) => type ?? "Device",
  sessionDeviceType: () => null,
}));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ warn: () => undefined, info: () => undefined }) }));

const { requestOpenDevices } = await import("../src/lib/pairing/newDevice");

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.sheetOpens = 0;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

const mountShell = async () => {
  const shell = { open: null as OpenDevices | null, settingsShown: 0 };
  const showSettings = () => {
    shell.settingsShown += 1;
  };
  const Probe = () => {
    shell.open = useOpenDevices(showSettings);
    return null;
  };
  await act(async () => {
    renderer = create(React.createElement(Probe));
  });
  return shell;
};

describe("open Your devices (ACCT-PAIR-03)", () => {
  it("tapping the notice opens Settings on Your devices", async () => {
    const shell = await mountShell();
    await act(async () => shell.open!.openDevices());
    console.log(TAG, "tap", { request: shell.open!.devicesRequest, settings: shell.settingsShown });
    expect([shell.open!.devicesRequest, shell.settingsShown]).toEqual([1, 1]);
  });

  it("the notification opens Your devices the same way", async () => {
    const shell = await mountShell();
    await act(async () => requestOpenDevices());
    expect([shell.open!.devicesRequest, shell.settingsShown]).toEqual([1, 1]);
  });

  it("the devices card opens its list for each request, never on its own", async () => {
    await act(async () => {
      renderer = create(React.createElement(DevicesSection, { token: "t", openRequest: 0 }));
    });
    const idle = ctl.sheetOpens;
    await act(async () => renderer!.update(React.createElement(DevicesSection, { token: "t", openRequest: 1 })));
    const first = ctl.sheetOpens;
    await act(async () => renderer!.update(React.createElement(DevicesSection, { token: "t", openRequest: 2 })));
    console.log(TAG, "sheet", { idle, first, second: ctl.sheetOpens });
    expect([idle, first, ctl.sheetOpens]).toEqual([0, 1, 2]);
  });
});
