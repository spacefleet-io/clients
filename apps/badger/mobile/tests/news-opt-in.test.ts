// @req ACCT-NEWS-01[badger-mobile]
// The phone's Settings has the News on/off switch (the phone has no sign-up, ACCT-AUTH-10, so this is its only
// place). The switch shows the account's saved value, sends `newsOptIn` to PATCH /account/settings, moves only once the
// server answers, and stays put when the save fails. The real SwitchRow and the real `@space/legal` words render;
// only the API call is a spy.
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@space/shared/api";
import { newsOptInText } from "@space/legal";
import { NewsOptInRow } from "../src/components/NewsOptInRow";

const api = vi.hoisted(() => ({ updateSettings: vi.fn() }));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  Switch: "Switch",
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  Modal: () => null,
  Animated: { View: "AnimatedView" },
}));
vi.mock("../src/components/usePickerSheet", () => ({
  usePickerSheet: () => ({ visible: false, open: () => undefined, close: () => undefined, closed: () => undefined }),
}));
// The shared sheet's drags load gesture-handler's native code; the settings rows render without it.
vi.mock("@space/mobile-shell/bottom-sheet", () => ({
  MobileBottomSheet: () => null,
  MobileSheetScrollView: "ScrollView",
  useMobileSheetClose: () => (after?: () => void) => after?.(),
}));
vi.mock("../src/components/BottomSheet", () => ({ BottomSheet: () => null }));
vi.mock("@space/mobile-shell/components", () => ({ SkyCover: "SkyCover" }));
vi.mock("@space/mobile-shell/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  return {
    defaultMobileShellTheme: { colors },
    mergeMobileShellTheme: (overrides: Record<string, unknown>) => ({ colors, ...overrides }),
    useMobileShellTheme: () => ({ colors }),
  };
});
vi.mock("lucide-react-native", () => ({ Check: () => null, ChevronRight: () => null }));
vi.mock("../src/components/PosterCard", () => ({ RIPPLE: {} }));
vi.mock("../src/components/Panel", () => ({ panelCardStyle: {} }));
vi.mock("@space/shared/api", () => ({ updateSettings: api.updateSettings }));

const baseUser = { id: "u1", email: "ada@example.test", isAdmin: false } as User;
const userWith = (newsOptIn: boolean): User => ({ ...baseUser, newsOptIn }) as User;

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  api.updateSettings.mockReset();
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

const theSwitch = (): ReactTestInstance => {
  if (!renderer) throw new Error("nothing mounted");
  return renderer.root.find((node) => node.props.accessibilityRole === "switch" && typeof node.type === "string");
};

/** Mounts the row the way Settings does: `onUser` stores what the server answered and re-renders with it. */
const mount = async (start: User, language = "en") => {
  let user = start;
  const seen: User[] = [];
  const element = () =>
    React.createElement(NewsOptInRow, {
      token: "token-1",
      user,
      language,
      onUser: (next: User) => {
        seen.push(next);
        user = next;
        renderer?.update(element());
      },
    });
  await act(async () => {
    renderer = create(element());
  });
  return { seen };
};

const press = async () => {
  await act(async () => {
    theSwitch().props.onPress();
  });
};

describe("News switch on the phone's Settings (ACCT-NEWS-01)", () => {
  it("shows the saved value and the shared News words, in the UI language", async () => {
    await mount(userWith(false), "fr");
    const row = theSwitch();
    console.info("[news] fr row", { label: row.props.accessibilityLabel, checked: row.props.accessibilityState.checked });
    expect(row.props.accessibilityLabel).toBe(newsOptInText("fr").news);
    expect(row.props.accessibilityHint).toBe(newsOptInText("fr").newsHint);
    expect(row.props.accessibilityState.checked).toBe(false);
  });

  it("an account with no saved choice shows the switch off", async () => {
    await mount(baseUser);
    expect(theSwitch().props.accessibilityState.checked).toBe(false);
  });

  it("turning it on sends newsOptIn to the account settings and shows what the server saved", async () => {
    api.updateSettings.mockResolvedValue({ user: userWith(true) });
    const { seen } = await mount(userWith(false));
    await press();
    console.info("[news] save calls", JSON.stringify(api.updateSettings.mock.calls));
    expect(api.updateSettings).toHaveBeenCalledWith("token-1", { newsOptIn: true });
    expect(seen.map((user) => user.newsOptIn)).toEqual([true]);
    expect(theSwitch().props.accessibilityState.checked).toBe(true);
  });

  it("turning it off sends false", async () => {
    api.updateSettings.mockResolvedValue({ user: userWith(false) });
    await mount(userWith(true));
    await press();
    expect(api.updateSettings).toHaveBeenCalledWith("token-1", { newsOptIn: false });
    expect(theSwitch().props.accessibilityState.checked).toBe(false);
  });

  it("a failed save leaves the switch on the saved value", async () => {
    api.updateSettings.mockRejectedValue(new Error("network down"));
    const { seen } = await mount(userWith(false));
    await press();
    console.info("[news] after failed save", { checked: theSwitch().props.accessibilityState.checked });
    expect(seen).toEqual([]);
    expect(theSwitch().props.accessibilityState.checked).toBe(false);
  });

  it("Settings shows the switch to a signed-in user", () => {
    const screen = readFileSync(join(__dirname, "../src/screens/SettingsScreen.tsx"), "utf8");
    expect(screen).toMatch(/\{token \? \([\s\S]*?<NewsOptInRow token=\{token\}/);
  });
});
