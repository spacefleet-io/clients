/**
 * @test-id BADGER-MOBILE-APPLE-UPDATE-REQUIRED-001
 * @level unit
 * @req REL-CD-29[badger-mobile,badger-tv]
 * @why REL-CD-29: Badger iOS/tvOS 0.1.2 met the vault v4 refusal with a text-only "Update Required … app_update_required"
 *   (the raw code, no button). The current iPhone and Apple TV builds must show the per-channel screen instead: a
 *   refused call latches, the navigator's gate puts the shared screen first, and the screen names TestFlight or the
 *   App Store (from the build's receipt) with one button to the right link on the iPhone, none on the Apple TV, and
 *   never the raw code. React Native is stubbed as host elements; the real API client, i18n and screen run.
 * @covers apps/badger/mobile/src/navigation/AppNavigator.tsx apps/badger/mobile/src/navigation/resolveScreen.ts packages/mobile-shell/src/components/mobile-update-required-screen.tsx packages/mobile-shell/src/updateSource.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: { OS: "ios", isTV: false },
  appInfo: { appVersion: "0.3.0", installer: null as string | null, appleDistribution: "testflight" as string },
  openURL: vi.fn(async () => undefined),
}));

vi.mock("react-native", () => ({
  Image: "Image",
  Text: "Text",
  View: "View",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  StyleSheet: { create: <T>(s: T) => s, hairlineWidth: 1 },
  Platform: native.platform,
  Linking: { openURL: native.openURL },
  NativeModules: { SpaceAppInfo: native.appInfo },
}));
vi.mock("@space/mobile-shell/theme", () => ({
  useMobileShellTheme: () => ({
    brandName: "Badger",
    mascotSource: 3,
    spacing: { xl: 32 },
    colors: { text: "#fff", textMuted: "#aaa", accent: "#f60", surfaceRaised: "#222", danger: "#f00" },
    accentTextHex: "#000",
    font: { size: { xl: 24, md: 16 }, family: { display: "Display", sans: "Sans" } },
  }),
}));

import { apiRequest, setApiBaseUrl } from "@space/shared/api";
import { __resetAppVersionStateForTests, getAppUpdateRequired } from "@space/shared/appVersion";
import { initI18n } from "@space/mobile-shell/i18n";
import { MobileUpdateRequiredScreen } from "@space/mobile-shell/update-required";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";

const T = "[BADGER-MOBILE-APPLE-UPDATE-REQUIRED-001]";
const say = (line: string, extra?: unknown) => console.info(`${T} ${line}`, extra === undefined ? "" : JSON.stringify(extra));

const refusal = { error: "app_update_required", app: "badger", platform: "ios", version: "0.3.0", minVersion: "0.4.0" };

const render = async (isTV: boolean, appleDistribution: "testflight" | "appstore") => {
  native.platform.isTV = isTV;
  native.appInfo.appleDistribution = appleDistribution;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(MobileUpdateRequiredScreen, { app: "badger" }));
  });
  const texts = tree.root.findAll((n) => String(n.type) === "Text").map((n) => [n.props.children].flat().join(""));
  const buttons = tree.root.findAll((n) => String(n.type) === "Pressable" && typeof n.props.testID === "string");
  return { tree, texts, buttons };
};

describe("Badger iPhone and Apple TV: the per-channel update screen, never the raw refusal code", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    __resetAppVersionStateForTests();
  });

  it("a refused call latches and the navigator's gate puts the update screen before everything else", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refusal), { status: 426 })));
    setApiBaseUrl("http://api.test");
    await apiRequest("/library", { method: "GET" }).catch(() => undefined);
    say("latched", getAppUpdateRequired());
    expect(getAppUpdateRequired()).toEqual(refusal);

    // The library may also report a contract issue or an error at that moment: the refusal still wins.
    const screen = resolveNavigatorScreen({
      updateRequired: true,
      authLoading: true,
      user: null,
      contractIssue: "app_update_required",
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: true,
      initializing: true,
      datasetStatus: { core: false },
      profiles: "ready",
    });
    expect(screen).toBe("contract-error");
    const navigator = readFileSync(path.resolve(import.meta.dirname, "../src/navigation/AppNavigator.tsx"), "utf8");
    const shared = navigator.indexOf('<MobileUpdateRequiredScreen app="badger" />');
    const rawText = navigator.indexOf('t("nav.updateRequired")');
    say("AppNavigator order", { shared, rawText });
    expect(navigator).toMatch(/if \(updateRequired\) \{\s*return \(\s*<SafeAreaView style=\{styles\.safeArea\}>\s*<MobileUpdateRequiredScreen app="badger" \/>/);
    expect(shared).toBeGreaterThan(0);
    expect(shared).toBeLessThan(rawText);
  });

  it("iPhone from TestFlight: names TestFlight, one button to Badger's public TestFlight link", async () => {
    const { texts, buttons } = await render(false, "testflight");
    say("iphone testflight", { texts, buttons: buttons.map((b) => b.props.testID) });
    expect(texts).toEqual([
      "Update Badger to keep using it",
      "This version of Badger is too old to connect. Install the new version of Badger from TestFlight, then open it again.",
      "Open TestFlight",
    ]);
    expect(buttons.map((b) => b.props.testID)).toEqual(["update-source-open-testflight"]);
    await act(async () => {
      buttons[0]!.props.onPress();
    });
    say("opened", native.openURL.mock.calls);
    expect(native.openURL).toHaveBeenLastCalledWith("https://testflight.apple.com/join/YmGWM7jf");
  });

  it("iPhone from the App Store: names the App Store, one button to Badger's App Store page", async () => {
    const { texts, buttons } = await render(false, "appstore");
    say("iphone appstore", { texts });
    expect(texts[1]).toBe("This version of Badger is too old to connect. Update Badger in the App Store, then open it again.");
    expect(buttons.map((b) => b.props.testID)).toEqual(["update-source-open-appstore"]);
    await act(async () => {
      buttons[0]!.props.onPress();
    });
    expect(native.openURL).toHaveBeenLastCalledWith("itms-apps://apps.apple.com/app/id6834213191");
  });

  it("Apple TV: names where the update comes from, no button (a TV opens no links), never the raw code", async () => {
    for (const distribution of ["testflight", "appstore"] as const) {
      const { texts, buttons } = await render(true, distribution);
      say(`apple tv ${distribution}`, { texts });
      expect(texts[1]).toContain(distribution === "testflight" ? "TestFlight" : "App Store");
      expect(buttons).toHaveLength(0);
      expect(texts.join(" ")).not.toMatch(/app_update_required|appUpdate\.|Update Required/);
    }
  });
});
