/**
 * @test-id PARROT-MOBILE-APP-UPDATE-REQUIRED-001
 * @level unit
 * @req REL-CD-29[parrot]
 * @why REL-CD-29: once the API refuses the Parrot phone build as too old (426 app_update_required, from any call,
 *   sign-in included), the app shows the update screen shared with Badger instead of anything else. The real API
 *   client and shared screen run (React Native stubbed as host elements, real i18n): the refusal of a Parrot call
 *   latches, the screen says "Parrot" in English and French and has no button, and the app's gate shows it first.
 * @covers apps/parrot/mobile/App.tsx packages/mobile-shell/src/components/mobile-update-required-screen.tsx
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Image: "Image",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Platform: { OS: "android", isTV: false },
  NativeModules: { SpaceAppInfo: { appVersion: "0.1.2", installer: "org.fdroid.fdroid" } },
}));
vi.mock("@space/mobile-shell/theme", () => ({
  useMobileShellTheme: () => ({
    brandName: "Parrot",
    mascotSource: 7,
    spacing: { xl: 32 },
    colors: { text: "#fff", textMuted: "#aaa" },
    font: { size: { xl: 24, md: 16 }, family: { display: "Display", sans: "Sans" } },
  }),
}));

import { ApiError, apiRequest, setApiBaseUrl } from "@space/shared/api";
import { __resetAppVersionStateForTests, getAppUpdateRequired, getClientIdentity } from "@space/shared/appVersion";
import { changeLanguage, initI18n } from "@space/mobile-shell/i18n";
import { MobileUpdateRequiredScreen, useAppUpdateRequired } from "@space/mobile-shell/update-required";
import "../src/config";

const T = "[PARROT-MOBILE-APP-UPDATE-REQUIRED-001]";
const say = (line: string, extra?: unknown) => console.info(`${T} ${line}`, extra === undefined ? "" : JSON.stringify(extra));

const refusal = { error: "app_update_required", app: "parrot", platform: "android", version: "0.1.2", minVersion: "0.2.0" };

const Gate = () => (useAppUpdateRequired() ? <MobileUpdateRequiredScreen /> : createElement("Text", null, "library"));

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => String(n.type) === "Text").map((n) => [n.props.children].flat().join(""));

describe("Parrot phone: the update screen once the API refuses this build", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await initI18n("en");
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    __resetAppVersionStateForTests();
  });

  it("a refused Parrot call latches and the gate turns into the update screen, in English and French", async () => {
    const identity = getClientIdentity();
    say("identity", identity);
    expect(identity).toEqual({ app: "parrot", platform: "android", version: "0.1.2+fdroid" });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Gate />);
    });
    say("before refusal", texts(tree));
    expect(tree.root.findAll((n) => n.props.testID === "update-required")).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refusal), { status: 426 })));
    setApiBaseUrl("http://api.test");
    let error: unknown;
    await act(async () => {
      error = await apiRequest("/auth/login", { method: "POST" }).catch((e: unknown) => e);
    });
    say("after refusal", { latched: getAppUpdateRequired(), error: String(error), texts: texts(tree) });
    expect(error).toBeInstanceOf(ApiError);
    expect(getAppUpdateRequired()).toEqual(refusal);

    const screen = tree.root.findAll((n) => n.props.testID === "update-required" && typeof n.type === "string");
    expect(screen).toHaveLength(1);
    expect(tree.root.findAll((n) => String(n.type) === "Image")[0]?.props.source).toBe(7);
    expect(tree.root.findAll((n) => n.props.onPress !== undefined)).toHaveLength(0);
    expect(texts(tree)).toEqual([
      "Update Parrot to keep using it",
      "This version of Parrot is too old to connect. Install the new version from where you got Parrot, then open it again.",
    ]);

    await act(async () => {
      await changeLanguage("fr");
    });
    const fr = texts(tree);
    say("fr", fr);
    expect(fr).toHaveLength(2);
    expect(fr.every((line) => line.includes("Parrot") && !line.includes("appUpdate."))).toBe(true);
    expect(fr[0]).not.toBe("Update Parrot to keep using it");
  });

  it("App.tsx shows the update screen before the spinner, sign-in, setup and the library", () => {
    const app = readFileSync(path.resolve(import.meta.dirname, "../App.tsx"), "utf8");
    const gate = app.indexOf("if (updateRequired && i18nReady) return <MobileUpdateRequiredScreen />;");
    const spinner = app.indexOf("if (booting || !i18nReady || !setup) return <Spinner />;");
    say("App.tsx order", { gate, spinner });
    expect(app).toContain('from "@space/mobile-shell/update-required"');
    expect(app).toContain("const updateRequired = useAppUpdateRequired();");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(spinner);
  });
});
