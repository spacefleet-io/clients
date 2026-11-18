/**
 * @test-id MOBILE-TITLE-LANGUAGE-KEEP-DEFAULT-001
 * @level integration
 * @bugfix @regression-proof
 *
 * "How should titles appear?" (ACCT-PROF-03) on Badger phone and TV (same code): keeping the preselected "App
 * language everywhere" and pressing Next is an answer, and it is saved (UX-SETUP-09). Found on the iPhone 0.1.2
 * Release build bd8ad72d9: `updateAppSettings` forwards only CHANGED fields to the profile, `titleLanguage` already
 * read "app" on screen, so nothing reached the profile, the navigator still saw an unanswered profile and asked
 * again forever (Next did nothing). The real settings store, profile binding and question gate run; the library is
 * an in-memory stand-in with LibraryDb's `getProfileSettings` / `setProfileSettings` / `onDataChanged` contract.
 *
 * @req UX-SETUP-09[badger-mobile,badger-tv]
 * @req ACCT-PROF-03[badger-mobile,badger-tv]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeProfileSettings,
  parseProfileSettings,
  scopedProfileSettingsKey,
  serializeProfileSettings,
  type ProfileSettings,
  type ProfileSettingsPatch,
} from "@space/shared/profileSettings";
import { viewingScopeFor, type ViewingScope } from "@space/shared/profileViewing";
import { TITLE_LANGUAGE_ASKED_SINCE } from "@space/shared/titleLanguage";
import * as appSettings from "../src/lib/appSettings";
import * as binding from "../src/lib/profileSettings";
import * as scope from "../src/lib/profiles/activeViewingScope";
import { activeProfileNeedsTitleLanguage, answerTitleLanguage } from "../src/lib/titleLanguageQuestion";
import { createFakeAsyncStorage } from "./harness";

const TAG = "[title-language-keep-default]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("react-native", () => ({
  Platform: { isTV: false, OS: "android" },
  I18nManager: { getConstants: () => ({ localeIdentifier: "en_US" }) },
  Settings: { get: () => undefined },
}));

const createLibrary = () => {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; patch: ProfileSettingsPatch }> = [];
  let clock = 0;
  return {
    values,
    writes,
    async getProfileSettings(target: ViewingScope): Promise<ProfileSettings | null> {
      return parseProfileSettings(values.get(scopedProfileSettingsKey(target)));
    },
    async setProfileSettings(patch: ProfileSettingsPatch, target: ViewingScope, options: { updatedAt?: string } = {}): Promise<void> {
      const key = scopedProfileSettingsKey(target);
      writes.push({ key, patch });
      const updatedAt = options.updatedAt ?? `2026-11-18T10:00:${String(++clock).padStart(2, "0")}.000Z`;
      values.set(key, serializeProfileSettings(mergeProfileSettings(parseProfileSettings(values.get(key)), patch, updatedAt)));
    },
    onDataChanged: () => () => undefined,
    dump: () => Object.fromEntries([...values].map(([key, value]) => [key, JSON.parse(value) as unknown])),
  };
};

/** A profile created after the question exists: it must answer once. */
const NEW_PROFILE = { id: "kid", createdAt: TITLE_LANGUAGE_ASKED_SINCE, isMain: false };
const KID = viewingScopeFor(NEW_PROFILE);
const KEY = scopedProfileSettingsKey(KID);
const snapshot = { profiles: [NEW_PROFILE], activeId: NEW_PROFILE.id } as unknown as Parameters<typeof activeProfileNeedsTitleLanguage>[0];
const needsQuestion = () => activeProfileNeedsTitleLanguage(snapshot, binding.getActiveTitleLanguageAnswer());

const start = async () => {
  binding.__resetProfileSettingsForTests();
  appSettings.__resetAppSettingsForTests();
  scope.setViewingScope(KID);
  await appSettings.loadAppSettings();
  const library = createLibrary();
  const detach = binding.attachProfileSettingsLibrary(library);
  await binding.profileSettingsIdle();
  return { library, detach };
};

beforeEach(() => {
  fakeStorage._backing.clear();
});

describe("@req UX-SETUP-09 keeping the preselected title language is an answer (phone and TV)", () => {
  it("Next on the preselected 'App language everywhere' saves it and the question is not asked again", async () => {
    const { library, detach } = await start();
    log("phase=before-answer", { shown: appSettings.getAppSettings().titleLanguage, answer: binding.getActiveTitleLanguageAnswer(), needs: needsQuestion(), library: library.dump() });
    expect(appSettings.getAppSettings().titleLanguage, "the screen already reads the default").toBe("app");
    expect(needsQuestion(), "a new profile that never answered is asked").toBe(true);

    log("phase=answer keep-default");
    answerTitleLanguage("app");
    await binding.profileSettingsIdle();
    log("phase=after-answer", { answer: binding.getActiveTitleLanguageAnswer(), needs: needsQuestion(), writes: library.writes, library: library.dump() });
    expect(JSON.parse(library.values.get(KEY) ?? "null")?.titleLanguage, "the kept default reaches the profile").toBe("app");
    expect(needsQuestion(), "the navigator moves on").toBe(false);

    log("phase=restart");
    detach();
    binding.__resetProfileSettingsForTests();
    binding.attachProfileSettingsLibrary(library);
    await binding.profileSettingsIdle();
    log("phase=after-restart", { answer: binding.getActiveTitleLanguageAnswer(), needs: needsQuestion() });
    expect(needsQuestion(), "answered for good: a restart does not ask again").toBe(false);
  });

  it("an ordinary settings edit that changes nothing still writes nothing", async () => {
    const { library } = await start();
    const before = library.writes.length;
    appSettings.updateAppSettings({ titleLanguage: "app", autoplayNextEpisode: appSettings.getAppSettings().autoplayNextEpisode });
    await binding.profileSettingsIdle();
    log("phase=no-op-edit", { writes: library.writes.slice(before) });
    expect(library.writes.length, "updateAppSettings keeps forwarding only changed fields").toBe(before);
  });
});
