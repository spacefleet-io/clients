/**
 * @test-id TV-SETUP-ORDER-001
 * @level unit
 * @why Badger TV follows the shared setup order (UX-SETUP-08, Chris 2026-11-11): "Choose your language" (step 0, no
 *   count) before the TV's sign-in, the sign-in not counted, then "Step N of M" over the library key (only after a
 *   password sign-in: pairing brings the key) and "Send error reports". A TV that was ever signed in never sees the
 *   language step again after a sign-out. The tests run the real navigator gate, the real TV numbering (shared
 *   `setupFlow`) and the real TV progress store over a fake AsyncStorage.
 *
 * @req UX-SETUP-08[badger-tv]
 * @req UX-SETUP-04[badger-tv]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";
import { tvLanguagePending, tvSetupForSession, tvSetupPosition } from "../src/tv/lib/tvSetup";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("react-native", () => ({ Platform: { isTV: true, OS: "android" } }));

/** The navigator as AppNavigator feeds it on a TV. */
const screenFor = (input: { progress: PhoneSetupProgress; user: boolean; needsKey?: boolean; errorReportsAnswered?: boolean }) => {
  const screen = resolveNavigatorScreen({
    authLoading: false,
    user: input.user ? { id: "u1" } : null,
    contractIssue: null,
    formatTooNew: false,
    needsKey: input.needsKey ?? false,
    errorReportsAnswered: input.errorReportsAnswered ?? false,
    initializing: false,
    datasetStatus: { core: true },
    profiles: "ready",
    tvLanguagePending: tvLanguagePending(input.progress),
  });
  console.info("[tv-setup-gate] screen", { step: input.progress.step, pairedKey: input.progress.pairedKey, user: input.user, needsKey: input.needsKey, screen });
  return screen;
};

// Fresh module state per boot, as after an app restart: the stores keep their live copy at module level, so the test
// reloads them (vi.resetModules + import) instead of importing them statically.
const boot = async () => {
  vi.resetModules();
  const settings = await import("../src/lib/appSettings");
  settings.__resetAppSettingsForTests();
  const store = await import("../src/tv/lib/tvSetupStore");
  store.__resetTvSetupForTests();
  return { settings, store };
};

beforeEach(() => {
  fakeStorage._backing.clear();
});

describe("Badger TV setup order", () => {
  it("a new TV asks its language before the sign-in, then the key is step 1 of 2 and error reports step 2 of 2", async () => {
    const { store } = await boot();
    let progress = await store.loadTvSetup();
    console.info("[tv-setup-gate] new TV", progress);
    expect(screenFor({ progress, user: false })).toBe("tv-language");

    // Next on the language step: the sign-in shows, still outside the numbered steps.
    await store.saveTvSetup({ ...progress, step: "signIn", language: "fr" });
    progress = store.getTvSetup()!;
    expect(screenFor({ progress, user: false })).toBe("auth");

    // Password sign-in, no key on this TV yet: the key screen, "Step 1 of 2".
    expect(screenFor({ progress, user: true, needsKey: true })).toBe("onboarding");
    expect(tvSetupPosition(progress, "libraryKey")).toEqual({ step: 1, total: 2 });
    // Key in: "Send error reports", "Step 2 of 2", then the app.
    expect(screenFor({ progress, user: true })).toBe("onboarding-reports");
    expect(tvSetupPosition(progress, "errorReports")).toEqual({ step: 2, total: 2 });
    expect(screenFor({ progress, user: true, errorReportsAnswered: true })).toBe("main");
  });

  it("pairing brings the key: error reports is step 1 of 1 and the key is not counted", async () => {
    const { store } = await boot();
    await store.saveTvSetup({ ...(await store.loadTvSetup()), step: "signIn" });
    await store.markTvSetupPaired();
    const progress = store.getTvSetup()!;
    expect(progress.pairedKey).toBe(true);
    expect(screenFor({ progress, user: true })).toBe("onboarding-reports");
    expect(tvSetupPosition(progress, "errorReports")).toEqual({ step: 1, total: 1 });
    expect(tvSetupPosition(progress, "libraryKey")).toEqual({ step: 0, total: 1 });
  });

  it("a TV that was signed in never sees the language step after a sign-out; a sign-out forgets the pairing", () => {
    // Signed in on the language step (a TV set up before the step existed, or restored signed in): marked as chosen.
    const signedIn = tvSetupForSession({ step: "language" as const, pairedKey: true }, true);
    expect(signedIn).toEqual({ step: "signIn", pairedKey: true });
    expect(tvSetupForSession(signedIn!, true)).toBeNull();
    // Signed out: the sign-in, not the language; the next sign-in counts its own key step.
    const signedOut = tvSetupForSession(signedIn!, false);
    expect(signedOut).toEqual({ step: "signIn", pairedKey: false });
    expect(tvLanguagePending(signedOut!)).toBe(false);
    expect(tvSetupPosition(signedOut!, "libraryKey")).toEqual({ step: 1, total: 2 });
    // A signed-out TV that never chose stays on the language.
    expect(tvSetupForSession({ step: "language" as const, pairedKey: false }, false)).toBeNull();
  });

  it("a TV that answered error reports before the language step existed opens on the sign-in", async () => {
    // The error-reports answer saved on this TV by an older build.
    await fakeStorage.setItem("sf:app-settings:v1", JSON.stringify({ errorReports: false, errorReportsDecided: true }));
    const { store } = await boot();
    const progress = await store.loadTvSetup();
    console.info("[tv-setup-gate] upgraded TV", progress);
    expect(progress.step).toBe("signIn");
    expect(screenFor({ progress, user: false })).toBe("auth");
  });

  it("the chosen language is kept on the TV across a restart", async () => {
    const { store } = await boot();
    await store.saveTvSetup({ ...(await store.loadTvSetup()), step: "signIn", language: "de" });
    const restarted = await boot();
    const progress = await restarted.store.loadTvSetup();
    expect(progress).toMatchObject({ step: "signIn", language: "de" });
    expect(screenFor({ progress, user: false })).toBe("auth");
  });
});
