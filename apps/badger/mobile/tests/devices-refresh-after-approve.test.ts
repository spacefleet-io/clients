// @req ACCT-DEV-01[badger-mobile] @bugfix @regression-proof
// QA (2026-11-08): after the phone approved a new device, the server had 5 sessions but the phone's Settings still
// said 4 devices until "Refresh" was pressed. The pairing screen records the approved session (`rememberSession`),
// which must also make any open devices list reload.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { DevicesSection } from "../src/components/DevicesSection";
import { rememberSession } from "../src/lib/pairing/deviceWatch";

const ctl = vi.hoisted(() => ({ sessions: [] as unknown[], listCalls: 0, store: new Map<string, string>() }));
const TAG = "[devices-refresh-after-approve]";

vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    View: "View",
    Text: "Text",
    ScrollView: "ScrollView",
    Pressable: "Pressable",
    Alert: { alert: () => undefined },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? React.createElement("Modal", null, children) : null,
    Animated: { View: "AnimatedView" },
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => ctl.store.get(key) ?? null,
    setItem: async (key: string, value: string) => void ctl.store.set(key, value),
    removeItem: async (key: string) => void ctl.store.delete(key),
  },
}));
vi.mock("../src/components/usePickerSheet", () => ({
  usePickerSheet: () => ({ visible: false, open: () => undefined, close: () => undefined, closed: () => undefined }),
}));
// The shared sheet's drags load gesture-handler's native code; the device list renders without it.
vi.mock("@space/mobile-shell/bottom-sheet", () => ({
  MobileBottomSheet: () => null,
  MobileSheetScrollView: "ScrollView",
  useMobileSheetClose: () => (after?: () => void) => after?.(),
}));
vi.mock("@space/mobile-shell/i18n", async () => {
  const enDict = (await import("../../../../packages/mobile-shell/src/i18n/en.json")).default;
  await i18next.init({
    resources: { en: { translation: enDict } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
  const translate = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
  return { translate, getCurrentLanguage: () => "en", useTranslation: () => ({ t: translate }) };
});
vi.mock("@space/mobile-shell/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  return { defaultMobileShellTheme: { colors }, useMobileShellTheme: () => ({ colors }) };
});
vi.mock("../src/components/BottomSheet", () => ({ BottomSheet: () => null }));
vi.mock("@space/mobile-shell/components", async () => {
  const React = await import("react");
  return {
    MobileButton: ({ label, onPress }: { label: string; onPress?: () => void }) =>
      React.createElement("Pressable", { accessibilityRole: "button", accessibilityLabel: label, onPress }),
    MobileCard: ({ children }: { children: React.ReactNode }) => React.createElement("View", null, children),
  };
});
vi.mock("@space/shared/api", () => ({
  listDevices: async () => {
    ctl.listCalls += 1;
    console.log(TAG, "listDevices", { call: ctl.listCalls, sessions: ctl.sessions.length });
    return { sessions: ctl.sessions };
  },
  revokeDevice: async () => undefined,
}));
vi.mock("@space/mobile-shell/pairing-approve", () => ({
  deviceTypeLabel: (type: string | null) => type ?? "Device",
  sessionDeviceType: (session: { clientType?: string }) => session.clientType ?? null,
}));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ warn: () => undefined, info: () => undefined }) }));

const session = (id: string, current = false) => ({ id, current, deviceName: `Device ${id}`, clientType: "web" });

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.sessions = [session("s1", true), session("s2"), session("s3"), session("s4")];
  ctl.listCalls = 0;
  ctl.store.clear();
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

const summary = (): string => {
  if (!renderer) throw new Error("nothing mounted");
  const node = renderer.root.find((item) => item.props.testID === "devices-summary" && typeof item.type === "string");
  return String(([] as unknown[]).concat(node.props.children).join(""));
};

describe("devices list after the phone approves a new device", () => {
  it("reloads by itself: the count goes from 4 to 5 without pressing Refresh", async () => {
    await act(async () => {
      renderer = create(React.createElement(DevicesSection, { token: "t" }));
    });
    console.log(TAG, "phase=mounted", { summary: summary(), listCalls: ctl.listCalls });
    expect(summary()).toBe("4 devices signed in");

    // The server now has the session the phone just approved; the pairing screen records it.
    ctl.sessions = [...ctl.sessions, session("s5")];
    await act(async () => {
      await rememberSession("s5");
    });
    console.log(TAG, "phase=approved", { summary: summary(), listCalls: ctl.listCalls, store: [...ctl.store.entries()] });

    expect(ctl.listCalls).toBe(2);
    expect(summary()).toBe("5 devices signed in");
  });
});
