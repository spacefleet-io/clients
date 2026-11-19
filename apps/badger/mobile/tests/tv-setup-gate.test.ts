/**
 * @test-id TV-SETUP-ORDER-001
 * @level unit
 * @why Badger TV follows the shared setup order (UX-SETUP-08, Chris 2026-11-11): "Choose your language" (step 0, no
 *   count) before the TV's sign-in, the sign-in not counted, then "Step N of M" over the library key (only after a
 *   password sign-in: pairing brings the key) and "Send error reports". A TV that was ever signed in never sees the
 *   language step again after a sign-out. The tests run the real navigator gate, the real TV numbering (shared
 *   `setupFlow`) and the real TV progress store over a fake AsyncStorage. "Your profile" (UX-SETUP-10, Chris
 *   2026-11-18) comes after "Who's watching?" and before error reports, numbered while the TV's first setup is open and
 *   the profile has it to do; it keeps its place once answered, and shows alone (no count) after the setup.
 *
 * @req UX-SETUP-08[badger-tv]
 * @req UX-SETUP-04[badger-tv]
 * @req UX-SETUP-10[badger-tv]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { resolveNavigatorScreen } from "../src/navigation/resolveScreen";
import { tvLanguagePending, tvProfileSetupPosition, tvSetupForSession, tvSetupPosition } from "../src/tv/lib/tvSetup";
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

  it("\"Your profile\" is step 2 of 3 after a password sign-in and 1 of 2 after pairing, between the key and error reports", async () => {
    const { store } = await boot();
    await store.saveTvSetup({ ...(await store.loadTvSetup()), step: "signIn" });
    let progress = store.getTvSetup()!;
    // Password sign-in, the profile picked has its avatar to set.
    expect(tvSetupPosition(progress, "libraryKey", true)).toEqual({ step: 1, total: 3 });
    expect(tvProfileSetupPosition(progress, true)).toEqual({ current: 2, total: 3 });
    expect(tvSetupPosition(progress, "errorReports", true)).toEqual({ step: 3, total: 3 });
    // A profile already set up on another app: the step is not counted.
    expect(tvSetupPosition(progress, "errorReports", false)).toEqual({ step: 2, total: 2 });

    // Pairing brings the key.
    await store.markTvSetupPaired();
    progress = store.getTvSetup()!;
    expect(tvProfileSetupPosition(progress, true)).toEqual({ current: 1, total: 2 });
    expect(tvSetupPosition(progress, "errorReports", true)).toEqual({ step: 2, total: 2 });
  });

  it("once answered, \"Your profile\" keeps its place across a restart, so error reports does not renumber", async () => {
    const { store } = await boot();
    await store.saveTvSetup({ ...(await store.loadTvSetup()), step: "signIn" });
    await store.markTvSetupPaired();
    await store.markTvProfileSetupAnswered();
    const restarted = await boot();
    const progress = await restarted.store.loadTvSetup();
    console.info("[tv-setup-gate] answered", progress);
    expect(progress.profileSetupAnswered).toBe(true);
    // The profile now has its avatar (not pending), the count stays.
    expect(tvSetupPosition(progress, "errorReports", false)).toEqual({ step: 2, total: 2 });
  });

  it("after the first setup (error reports answered) \"Your profile\" shows alone, with no count", async () => {
    const { store } = await boot();
    await store.saveTvSetup({ ...(await store.loadTvSetup()), step: "signIn" });
    expect(tvProfileSetupPosition(store.getTvSetup()!, false)).toBeUndefined();
  });
});
