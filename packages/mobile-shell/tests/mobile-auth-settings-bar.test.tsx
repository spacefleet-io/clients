/**
 * @test-id MOBILE-SHELL-AUTH-SETTINGS-BAR-001
 * @level unit
 * @bugfix @regression-proof
 * @why The login screen's "API host" gear (debug and server-picker builds) was a Pressable with a label and no role:
 *   VoiceOver read the label without saying it is a button, and the iPhone UI tests (PR #2121, 2026-11-13) saw it as
 *   "Other", not "Button". Every control a screen-reader user presses must say what it is (UX-A11Y-01).
 */
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(s: T) => s },
}));
vi.mock("lucide-react-native", () => ({ Settings: "Icon" }));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("../src/theme", () => ({ useMobileShellTheme: () => ({ colors: { border: "#333", textMuted: "#aaa" } }) }));

import { MobileAuthSettingsBar } from "../src/components/mobile-auth-settings-bar";

const render = (onApiHostPress?: () => void) => {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = create(createElement(MobileAuthSettingsBar, { languageMenu: createElement("LanguageMenu"), onApiHostPress }));
  });
  return tree!;
};

describe("MobileAuthSettingsBar", () => {
  it("the API host gear is announced as a button with its label", () => {
    const gear = render(() => undefined).root.findByType("Pressable" as never);
    expect(gear.props.accessibilityLabel).toBe("authApiHost.button");
    expect(gear.props.accessibilityRole).toBe("button");
  });

  it("no gear where the build has no server picker (ACCT-AUTH-09)", () => {
    expect(render().root.findAllByType("Pressable" as never)).toHaveLength(0);
  });
});
