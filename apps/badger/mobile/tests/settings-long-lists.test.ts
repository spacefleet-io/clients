// @req UX-LIST-01[badger-mobile]
// A long choice (the default audio language) and a data-driven list (signed-in devices) show on Settings as one row
// or one button; the full list only appears in its own sheet once that row is pressed. Short choices stay inline.
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { ChoiceRow } from "../src/components/SettingsRows";
import { INLINE_CHOICE_LIMIT } from "../src/lib/choiceLayout";
import { DevicesSection } from "../src/components/DevicesSection";

// vi.mock factories are hoisted above every import, so they load what they need (React, the dictionary) themselves.

const ctl = vi.hoisted(() => ({ sessions: [] as unknown[] }));

vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    View: "View",
    Text: "Text",
    ScrollView: "ScrollView",
    Pressable: "Pressable",
    Switch: "Switch",
    Alert: { alert: () => undefined },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    // The real Modal only mounts its content while visible; so does this one.
    Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? React.createElement("Modal", null, children) : null,
    Animated: { View: "AnimatedView" },
  };
});
// The shared sheet's slide and drags need native code; this stand-in shows its content while open. A person closing it
// reports onClose then onClosed, and a sheet the parent hides reports onClosed: the same calls as the real one.
vi.mock("@space/mobile-shell/bottom-sheet", async () => {
  const React = await import("react");
  type Props = { visible: boolean; onClose: () => void; onClosed?: () => void; testID?: string; children: React.ReactNode };
  const MobileBottomSheet = ({ visible, onClose, onClosed, testID, children }: Props) => {
    const wasVisible = React.useRef(visible);
    const closedByPerson = React.useRef(false);
    React.useEffect(() => {
      if (wasVisible.current && !visible && !closedByPerson.current) onClosed?.();
      wasVisible.current = visible;
      closedByPerson.current = false;
    }, [visible, onClosed]);
    if (!visible) return null;
    const closeByPerson = () => {
      closedByPerson.current = true;
      onClose();
      onClosed?.();
    };
    return React.createElement(
      "Modal",
      { testID },
      React.createElement("Pressable", { testID: testID ? `${testID}-backdrop` : undefined, onPress: closeByPerson }),
      children,
    );
  };
  return {
    MobileBottomSheet,
    MobileSheetScrollView: "ScrollView",
    useMobileSheetClose: () => (after?: () => void) => after?.(),
  };
});
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
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover" }));
vi.mock("@space/mobile-shell/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  // The app builds Badger's shell theme from the default one (UX-CRASH-01 brand name, UX-SKY-03 nebula).
  return {
    defaultMobileShellTheme: { colors },
    mergeMobileShellTheme: (overrides: Record<string, unknown>) => ({ colors, ...overrides }),
    useMobileShellTheme: () => ({ colors }),
  };
});
vi.mock("lucide-react-native", () => ({ Check: () => null, ChevronRight: () => null }));
vi.mock("../src/components/PosterCard", () => ({ RIPPLE: {} }));
vi.mock("../src/components/Panel", () => ({ panelCardStyle: {} }));
vi.mock("../src/components/ui", async () => {
  const React = await import("react");
  return {
    Button: ({ label, onPress }: { label: string; onPress?: () => void }) =>
      React.createElement("Pressable", { accessibilityRole: "button", accessibilityLabel: label, onPress }),
    Card: ({ children }: { children: React.ReactNode }) => React.createElement("View", null, children),
  };
});
vi.mock("@space/shared/api", () => ({
  listDevices: async () => ({ sessions: ctl.sessions }),
  revokeDevice: async () => undefined,
}));
vi.mock("../src/lib/pairing/newDevice", () => ({
  subscribeNewDevice: () => () => undefined,
  subscribeDevicesChanged: () => () => undefined,
}));
vi.mock("@space/mobile-shell/pairing-approve", () => ({
  deviceTypeLabel: (type: string | null) => type ?? "Device",
  sessionDeviceType: (session: { clientType?: string }) => session.clientType ?? null,
}));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ warn: () => undefined, info: () => undefined }) }));

const LANGUAGES = ["Original", "English", "Français", "Deutsch", "Español", "Italiano", "Português", "Nederlands", "Svenska"];

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

const root = (): ReactTestInstance => {
  if (!renderer) throw new Error("nothing mounted");
  return renderer.root;
};
const byRole = (role: string) => root().findAll((node) => node.props.accessibilityRole === role && typeof node.type === "string");
const labels = (nodes: ReactTestInstance[]) => nodes.map((node) => String(node.props.accessibilityLabel));

const mount = async (element: React.ReactElement) => {
  await act(async () => {
    renderer = create(element);
  });
};

describe("Settings choices", () => {
  it("a choice with more than 6 options is one row; its options only appear in the sheet, and a pick closes it", async () => {
    const picked: string[] = [];
    const options = LANGUAGES.map((label) => ({ value: label.toLowerCase(), label }));
    expect(options.length).toBeGreaterThan(INLINE_CHOICE_LIMIT);
    await mount(
      React.createElement(ChoiceRow<string>, {
        title: "Default audio language",
        options,
        value: "français",
        onChange: (value: string) => picked.push(value),
      }),
    );

    console.log("collapsed", { buttons: labels(byRole("button")), radios: labels(byRole("radio")) });
    expect(byRole("radio")).toHaveLength(0);
    expect(labels(byRole("button"))).toEqual(["Default audio language: Français"]);

    await act(async () => {
      byRole("button")[0].props.onPress();
    });
    const radios = byRole("radio");
    console.log("sheet open", { radios: labels(radios) });
    expect(labels(radios)).toEqual(LANGUAGES);
    expect(radios.find((radio) => radio.props.accessibilityState.selected)?.props.accessibilityLabel).toBe("Français");
    expect(root().findAll((node) => String(node.type) === "ScrollView")).toHaveLength(1);

    await act(async () => {
      radios[LANGUAGES.indexOf("Svenska")].props.onPress();
    });
    expect(picked).toEqual(["svenska"]);
    expect(byRole("radio")).toHaveLength(0);
  });

  it("a choice with at most 6 options stays inline as chips", async () => {
    const options = LANGUAGES.slice(0, INLINE_CHOICE_LIMIT).map((label) => ({ value: label, label }));
    await mount(React.createElement(ChoiceRow<string>, { title: "Quality", options, value: "English", onChange: () => undefined }));
    console.log("inline", { radios: labels(byRole("radio")) });
    expect(labels(byRole("radio"))).toEqual(LANGUAGES.slice(0, INLINE_CHOICE_LIMIT));
    expect(byRole("button")).toHaveLength(0);
  });
});

describe("Your devices", () => {
  it("Settings shows a count and one button; every device appears only in the sheet", async () => {
    ctl.sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `s${index}`,
      deviceName: index === 0 ? "My phone" : `Device ${index}`,
      clientType: "badger-mobile",
      current: index === 0,
      lastSeen: "2026-10-20T08:00:00.000Z",
    }));
    await mount(React.createElement(DevicesSection, { token: "token" }));

    const rows = () => root().findAll((node) => node.props.testID === "device-row" && typeof node.type === "string");
    const summary = root().find((node) => node.props.testID === "devices-summary" && typeof node.type === "string");
    console.log("devices collapsed", { summary: summary.props.children, rows: rows().length, buttons: labels(byRole("button")) });
    expect(summary.props.children).toBe("12 devices signed in");
    expect(rows()).toHaveLength(0);
    expect(labels(byRole("button"))).toEqual(["See all devices"]);

    await act(async () => {
      byRole("button")[0].props.onPress();
    });
    console.log("devices sheet", { rows: rows().length, buttons: labels(byRole("button")) });
    expect(rows()).toHaveLength(12);
    // Every device but this one can be signed out, plus the refresh button.
    expect(labels(byRole("button")).filter((label) => label === "Sign out")).toHaveLength(11);
  });
});
