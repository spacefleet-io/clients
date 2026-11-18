/**
 * @test-id MOBILE-SETUP-001
 * @level unit
 * @why Badger phone's first setup (UX-SETUP-08, UX-SETUP-03) runs language and sign in (not counted), the account's
 *   language settled, then library key (regular sign-in only), "Who's watching?", notifications, error reports, in that
 *   order, with "step N of M" on the numbered ones and Back; the progress is saved after
 *   every answer and resumes where it was left, once per phone (UX-SETUP-07), and a phone set up before the walkthrough
 *   existed never sees it. The tests run the real navigator gate, the real shared order and the real progress store
 *   (fake AsyncStorage).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextPhoneSetupStep, phoneSetupPosition, previousPhoneSetupStep, resolvePhoneSetupStep, type PhoneSetupProgress } from "@space/mobile-shell/setup";
import { resolveNavigatorScreen, type SetupGate } from "../src/navigation/resolveScreen";
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

/** The navigator as AppNavigator feeds it on a phone. */
const screenFor = (input: {
  progress: PhoneSetupProgress;
  user: boolean;
  needsKey: boolean;
  profiles?: "ready" | "choose";
  libraryReady?: boolean;
  errorReportsAnswered?: boolean;
}) => {
  const setup: SetupGate = {
    done: input.progress.done,
    step: resolvePhoneSetupStep(input.progress, { hasKey: !input.needsKey, signedIn: input.user }),
    languageReconciled: input.progress.languageReconciled,
  };
  const screen = resolveNavigatorScreen({
    authLoading: false,
    user: input.user ? { id: "u1" } : null,
    contractIssue: null,
    formatTooNew: false,
    needsKey: input.needsKey,
    errorReportsAnswered: input.errorReportsAnswered ?? false,
    initializing: false,
    datasetStatus: { core: input.libraryReady ?? true },
    profiles: input.profiles ?? "ready",
    setup,
  });
  console.info("[phone-setup-gate] screen", { saved: input.progress.step, resolved: setup.step, user: input.user, needsKey: input.needsKey, screen });
  return { screen, step: setup.step };
};

const fresh = (patch: Partial<PhoneSetupProgress> = {}): PhoneSetupProgress => ({
  step: "language",
  done: false,
  pairedKey: false,
  language: null,
  notifications: null,
  languageReconciled: true,
  ...patch,
});

const boot = async () => {
  vi.resetModules();
  const settings = await import("../src/lib/appSettings");
  settings.__resetAppSettingsForTests();
  const store = await import("../src/setup/phoneSetupStore");
  store.__resetPhoneSetupForTests();
  return { settings, store };
};

beforeEach(() => {
  fakeStorage._backing.clear();
});

describe("Badger phone setup order", () => {
  // @req UX-SETUP-03[badger-mobile]
  // @req UX-SETUP-02[badger-mobile]
  // @req UX-SETUP-08[badger-mobile]
  it("walks language, sign in, key, Who's watching?, notifications, error reports, then the app", () => {
    let progress = fresh();
    expect(screenFor({ progress, user: false, needsKey: false }).screen).toBe("setup");
    expect(phoneSetupPosition(progress)).toEqual({ step: 0, total: 3 });

    progress = { ...progress, language: "fr", step: nextPhoneSetupStep(progress)! };
    expect(progress.step).toBe("signIn");
    expect(screenFor({ progress, user: false, needsKey: false }).screen).toBe("auth");
    expect(phoneSetupPosition(progress)).toEqual({ step: 0, total: 3 });

    // Just signed in: the language picked before the sign-in is settled with the account's first.
    expect(screenFor({ progress: { ...progress, languageReconciled: false }, user: true, needsKey: true })).toEqual({ screen: "setup", step: "libraryKey" });

    // Regular sign-in, no key yet: the key screen is step 1.
    const atKey = screenFor({ progress, user: true, needsKey: true });
    expect(atKey).toEqual({ screen: "onboarding", step: "libraryKey" });
    expect(phoneSetupPosition({ ...progress, step: "libraryKey" })).toEqual({ step: 1, total: 3 });

    // Key in, several profiles: "Who's watching?" before the notifications screen.
    expect(screenFor({ progress, user: true, needsKey: false, profiles: "choose" }).screen).toBe("profiles");
    // Library still opening: its loading screen, still before the notifications.
    expect(screenFor({ progress, user: true, needsKey: false, libraryReady: false }).screen).toBe("loading-library");
    const atNotifications = screenFor({ progress, user: true, needsKey: false });
    expect(atNotifications).toEqual({ screen: "setup", step: "notifications" });
    expect(phoneSetupPosition({ ...progress, step: "notifications" })).toEqual({ step: 2, total: 3 });

    progress = { ...progress, step: "errorReports", notifications: true };
    expect(screenFor({ progress, user: true, needsKey: false })).toEqual({ screen: "setup", step: "errorReports" });
    expect(phoneSetupPosition(progress)).toEqual({ step: 3, total: 3 });
    expect(nextPhoneSetupStep(progress)).toBeNull();

    // Done (the error reports answer is saved with it): straight to the app, the old error-reports gate never shows.
    expect(screenFor({ progress: { ...progress, done: true }, user: true, needsKey: false, errorReportsAnswered: true }).screen).toBe("main");
  });

  // @req UX-SETUP-03[badger-mobile]
  it("pairing brings the key: two numbered steps, no key screen", () => {
    const progress = fresh({ step: "signIn", pairedKey: true });
    expect(phoneSetupPosition(progress)).toEqual({ step: 0, total: 2 });
    expect(screenFor({ progress, user: true, needsKey: false })).toEqual({ screen: "setup", step: "notifications" });
    expect(phoneSetupPosition({ ...progress, step: "notifications" })).toEqual({ step: 1, total: 2 });
  });

  // @req UX-SETUP-02[badger-mobile]
  it("Back from the notifications screen goes to the language, the sign-in and key being done", () => {
    expect(previousPhoneSetupStep(fresh({ step: "notifications" }))).toBe("language");
    expect(previousPhoneSetupStep(fresh({ step: "notifications", pairedKey: true }))).toBe("language");
    expect(previousPhoneSetupStep(fresh({ step: "errorReports" }))).toBe("notifications");
    expect(previousPhoneSetupStep(fresh({ step: "language" }))).toBeNull();
    // Language while signed in: shown before the auth gate; Next goes past the done sign-in and key.
    const back = fresh({ step: "language" });
    expect(screenFor({ progress: back, user: true, needsKey: false }).screen).toBe("setup");
    const next = { ...back, step: nextPhoneSetupStep(back)! };
    expect(screenFor({ progress: next, user: true, needsKey: false })).toEqual({ screen: "setup", step: "notifications" });
  });

  // @req UX-SETUP-07[badger-mobile]
  it("signed out partway: the setup goes back to the sign-in", () => {
    const progress = fresh({ step: "notifications" });
    expect(screenFor({ progress, user: false, needsKey: false })).toEqual({ screen: "auth", step: "signIn" });
  });

  it("the TV (no setup gate) keeps its old gates", () => {
    const screen = resolveNavigatorScreen({
      authLoading: false,
      user: null,
      contractIssue: null,
      formatTooNew: false,
      needsKey: false,
      errorReportsAnswered: false,
      initializing: false,
      datasetStatus: { core: true },
    });
    expect(screen).toBe("auth");
  });
});

describe("Badger phone setup progress store", () => {
  // @req UX-SETUP-07[badger-mobile]
  it("saves every answer and resumes at the step left after a restart", async () => {
    let { store } = await boot();
    expect(await store.loadPhoneSetup()).toEqual(fresh({ languageReconciled: false }));
    await store.savePhoneSetup(fresh({ step: "signIn", language: "de" }));
    console.info("[phone-setup-gate] saved", fakeStorage._backing.get(store.PHONE_SETUP_STORAGE_KEY));

    ({ store } = await boot());
    expect(await store.loadPhoneSetup()).toEqual(fresh({ step: "signIn", language: "de" }));
    await store.markPhoneSetupPaired();
    ({ store } = await boot());
    expect((await store.loadPhoneSetup()).pairedKey).toBe(true);
  });

  // @req UX-SETUP-07[badger-mobile]
  it("runs once: a finished setup stays finished", async () => {
    let { store } = await boot();
    await store.loadPhoneSetup();
    await store.savePhoneSetup(fresh({ step: "errorReports", done: true }));
    ({ store } = await boot());
    expect((await store.loadPhoneSetup()).done).toBe(true);
  });

  // @req UX-SETUP-07[badger-mobile]
  it("a phone set up before the walkthrough existed (error reports answered) never sees it", async () => {
    let { settings, store } = await boot();
    await settings.loadAppSettings();
    settings.updateAppSettings({ errorReports: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    ({ settings, store } = await boot());
    const progress = await store.loadPhoneSetup();
    console.info("[phone-setup-gate] existing install", progress);
    expect(progress.done).toBe(true);
  });
});
