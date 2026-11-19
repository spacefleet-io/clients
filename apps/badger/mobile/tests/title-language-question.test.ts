/**
 * "How should titles appear?" (ACCT-PROF-03) in Badger phone and TV: asked only of a profile created since the
 * question exists that never answered it, outside the phone's first setup on its own screen right after the profile
 * is picked (a profile created later, the TV), never over the first setup (where it is a numbered step).
 *
 * @req ACCT-PROF-03[badger-mobile,badger-tv]
 */
import { describe, expect, it, vi } from "vitest";
import { TITLE_LANGUAGE_ASKED_SINCE } from "@space/shared/titleLanguage";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";
import { activeProfileNeedsTitleLanguage } from "../src/lib/titleLanguageQuestion";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("react-native", () => ({ Platform: { isTV: false, OS: "android" } }));

const NEW = { id: "p-new", name: "Kid", avatar: 1, avatarId: "fox" as const, createdAt: TITLE_LANGUAGE_ASKED_SINCE, isMain: false };
const OLD = { id: "p-old", name: "Main", avatar: 0, avatarId: "raccoon" as const, createdAt: "2026-01-02T00:00:00.000Z", isMain: true };

describe("who is asked", () => {
  it("only a profile created since the question exists that never answered; unknown until picked and read", () => {
    const profiles = [OLD, NEW];
    const cases: Array<[string, string | null, { titleLanguage?: unknown } | null, boolean | null]> = [
      ["no profile picked", null, {}, null],
      ["settings not read", NEW.id, null, null],
      ["new, never answered", NEW.id, {}, true],
      ["new, answered original", NEW.id, { titleLanguage: "original" }, false],
      ["new, answered app", NEW.id, { titleLanguage: "app" }, false],
      ["new, garbage answer", NEW.id, { titleLanguage: "klingon" }, true],
      ["existing profile, never answered", OLD.id, {}, false],
    ];
    for (const [label, activeId, answer, expected] of cases) {
      const got = activeProfileNeedsTitleLanguage({ profiles, activeId }, answer);
      console.info("[title-language] needs", { label, got });
      expect(got, label).toBe(expected);
    }
  });
});

const gates = (patch: Partial<Parameters<typeof resolveNavigatorScreen>[0]> = {}) =>
  resolveNavigatorScreen({
    authLoading: false,
    user: { id: "u1" },
    contractIssue: null,
    formatTooNew: false,
    needsKey: false,
    errorReportsAnswered: true,
    initializing: false,
    datasetStatus: { core: true },
    profiles: "ready",
    ...patch,
  });

describe("where the standalone question shows", () => {
  it("right after the profile is picked and the library opens, before the app", () => {
    expect(gates({ titleLanguageQuestion: true })).toBe("title-language");
    expect(gates({ titleLanguageQuestion: false })).toBe("main");
    expect(gates({ titleLanguageQuestion: true, profiles: "choose" })).toBe("profiles");
    expect(gates({ titleLanguageQuestion: true, datasetStatus: { core: false } })).toBe("loading-library");
    expect(gates({ titleLanguageQuestion: true, needsKey: true })).toBe("onboarding");
  });

  it("never over the phone's open first setup, which asks it as a numbered step", () => {
    const setup = { done: false, step: "titleLanguage" as const, languageReconciled: true };
    expect(gates({ titleLanguageQuestion: true, setup })).toBe("setup");
    expect(gates({ titleLanguageQuestion: true, setup: { ...setup, done: true } })).toBe("title-language");
  });

  it("on the TV (no phone setup), the same screen once its profile is picked", () => {
    expect(gates({ titleLanguageQuestion: true, setup: undefined, tvLanguagePending: false })).toBe("title-language");
  });
});
