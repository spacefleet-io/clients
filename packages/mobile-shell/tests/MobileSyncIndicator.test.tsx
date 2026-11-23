/**
 * @test-id MOBILE-SHELL-SYNC-INDICATOR-001
 * @level unit
 * @req LIB-SYNC-13[badger-mobile]
 * @why Chris 2026-11-21 (chat): after a night of episode uploads from Badger desktop the phone showed the old library
 *   with no sign that anything was loading. The tab bar now carries a small sign while the library updates:
 *   "Updating library…" (with a percentage once the pages are counted), then a quiet result ("12 new episodes", "Up to
 *   date"), and a failure that stays in the danger colour and retries on tap. This pins every state's copy and wiring.
 */
import React from "react";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../src/i18n";
import { MobileSyncIndicator, syncIndicatorCopy, type MobileSyncIndicatorState } from "../src/components/mobile-sync-indicator";

const stubs = vi.hoisted(() => {
  type Stub = ((props: unknown) => unknown) & { displayName?: string };
  const make = (name: string): Stub => {
    const stub: Stub = (props) => props;
    stub.displayName = name;
    return stub;
  };
  return {
    PressableStub: make("PressableStub"),
    TextStub: make("TextStub"),
    ViewStub: make("ViewStub"),
    SpinnerStub: make("SpinnerStub"),
  };
});

vi.mock("react-native", () => ({
  ActivityIndicator: stubs.SpinnerStub,
  Pressable: stubs.PressableStub,
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: stubs.TextStub,
  View: stubs.ViewStub,
}));
vi.mock("lucide-react-native", () => ({ Check: () => null, RefreshCw: () => null }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { danger: "#ff7f7f", accent: "#ffb357", success: "#70dbaf" } }),
}));
// Invoked as a pure function the component has no React renderer: bind useTranslation() to the real i18next instance.
// The dynamic import is required: vi.mock factories are hoisted above the static imports.
vi.mock("react-i18next", async () => {
  const { default: instance } = await import("i18next");
  return {
    initReactI18next: { type: "3rdParty", init: () => undefined },
    useTranslation: () => ({ t: instance.t.bind(instance) }),
  };
});

const t = i18next.t.bind(i18next);

beforeAll(async () => {
  await initI18n("en");
});

const render = (state: MobileSyncIndicatorState, onRetry = () => undefined) =>
  MobileSyncIndicator({ state, onRetry }) as React.ReactElement<Record<string, unknown>>;

describe("syncIndicatorCopy: what each sync state says", () => {
  const cases: [string, MobileSyncIndicatorState, string, string][] = [
    ["syncing, progress unknown", { kind: "syncing", progress: null }, "Updating library…", "busy"],
    ["syncing, pages counted", { kind: "syncing", progress: 0.426 }, "Updating library… 43%", "busy"],
    ["new episodes", { kind: "done", changed: true, newTitles: 1, newEpisodes: 12 }, "12 new episodes", "quiet"],
    ["one new episode", { kind: "done", changed: true, newTitles: 0, newEpisodes: 1 }, "1 new episode", "quiet"],
    ["new titles only", { kind: "done", changed: true, newTitles: 3, newEpisodes: 0 }, "3 new titles", "quiet"],
    ["changed, counts unknown", { kind: "done", changed: true, newTitles: null, newEpisodes: null }, "Library updated", "quiet"],
    ["nothing new", { kind: "done", changed: false, newTitles: 0, newEpisodes: 0 }, "Up to date", "quiet"],
    ["failed", { kind: "failed" }, "Update failed", "danger"],
  ];
  for (const [name, state, text, tone] of cases) {
    it(name, () => {
      const copy = syncIndicatorCopy(state, t);
      console.info(`[mobile-sync-indicator:${name}] state=${JSON.stringify(state)} copy=${JSON.stringify(copy)}`);
      expect(copy.text).toBe(text);
      expect(copy.tone).toBe(tone);
    });
  }

  it("the syncing label says the saved library stays usable; the failed one says how to retry", () => {
    expect(syncIndicatorCopy({ kind: "syncing", progress: null }, t).label).toBe(
      "Updating library… — Your saved media library stays available",
    );
    expect(syncIndicatorCopy({ kind: "failed" }, t).label).toBe("Media library update failed — saved content. Tap to retry.");
  });

  it("every language has every key", async () => {
    for (const language of ["fr", "de", "es", "nl"]) {
      await i18next.changeLanguage(language);
      const keys = ["updating", "updatingProgress", "savedStaysLabel", "updated", "upToDate", "failed", "failedLabel", "retry"];
      for (const key of keys) {
        const value = t(`sync.indicator.${key}`, { percent: 5 });
        console.info(`[mobile-sync-indicator:i18n] ${language} ${key}=${JSON.stringify(value)}`);
        expect(value, `${language} sync.indicator.${key}`).not.toBe(`sync.indicator.${key}`);
      }
      expect(t("sync.indicator.newEpisodes", { count: 2 })).not.toContain("sync.indicator");
      expect(t("sync.indicator.newTitles", { count: 2 })).not.toContain("sync.indicator");
    }
    await i18next.changeLanguage("en");
  });
});

describe("MobileSyncIndicator wiring", () => {
  it("a running sync is a passive live region with a spinner, not a button", () => {
    const tree = render({ kind: "syncing", progress: 0.5 });
    console.info(`[mobile-sync-indicator:wiring-syncing] props=${JSON.stringify(tree.props.accessibilityLabel)}`);
    expect(tree.type).toBe(stubs.ViewStub);
    expect(tree.props.accessibilityLiveRegion).toBe("polite");
    expect(tree.props.onPress).toBeUndefined();
    // The pill's content is one fragment (icon, text) shared by both shapes.
    const fragment = tree.props.children as React.ReactElement<{ children: React.ReactNode }>;
    const [icon, text] = React.Children.toArray(fragment.props.children) as React.ReactElement<{ children?: unknown }>[];
    expect(icon?.type).toBe(stubs.SpinnerStub);
    expect(text?.props.children).toBe("Updating library… 50%");
  });

  it("a failure is a button that retries", () => {
    const onRetry = vi.fn();
    const tree = render({ kind: "failed" }, onRetry);
    expect(tree.type).toBe(stubs.PressableStub);
    (tree.props.onPress as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
