/**
 * The desktop profile store (`src/renderer/src/lib/profileStore.ts`): the shared store on localStorage, with the
 * library's active profile set through the bridge (ACCT-SQUAD-02), "Who's watching?" at every start (UX-PROF-02), and
 * a profile's library data moved when it is deleted (ACCT-PROF-02).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import type * as DesktopProfilesModule from "../src/renderer/src/lib/profileStore";

const LOG = "[profiles-store]";
const USER = "user-1";
const CHRIS: ApiProfile = { id: "p-chris", name: "Chris", isMain: true, createdAt: "2026-10-01T00:00:00.000Z" } as ApiProfile;
const KIDS: ApiProfile = { id: "p-kids", name: "Kids", isMain: false, createdAt: "2026-10-02T00:00:00.000Z" } as ApiProfile;
const LIST: ProfilesResponse = { profiles: [CHRIS, KIDS], maxProfiles: 5 };

const api = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));

vi.mock("@/api", async () => {
  const shared = await vi.importActual<typeof import("@space/shared/api")>("@space/shared/api");
  return { ApiError: shared.ApiError, ...api };
});
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});

const storage = new Map<string, string>();
const bridgeSetActiveProfile = vi.fn();

type DesktopProfiles = typeof DesktopProfilesModule;

/** A fresh module = a fresh start of the app (the store is a module singleton), so this reload is the point. */
const startApp = async (): Promise<DesktopProfiles> => {
  vi.resetModules();
  return await import("../src/renderer/src/lib/profileStore");
};

const dump = (label: string, mod?: DesktopProfiles) =>
  console.error(
    `${LOG} ${label}`,
    JSON.stringify({
      snapshot: mod?.profileStore.getSnapshot() ?? null,
      storage: [...storage.entries()],
      bridgeCalls: bridgeSetActiveProfile.mock.calls,
      apiList: api.listProfiles.mock.calls.length,
    }),
  );

describe("desktop profile store", () => {
  beforeEach(() => {
    storage.clear();
    bridgeSetActiveProfile.mockReset();
    bridgeSetActiveProfile.mockResolvedValue({ applied: true });
    api.listProfiles.mockReset();
    api.listProfiles.mockResolvedValue(LIST);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    });
    vi.stubGlobal("window", { sf: { libraryDb: { setActiveProfile: bridgeSetActiveProfile } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // @req UX-PROF-02[badger-desktop]
  // @req UX-PROF-01[badger-desktop]
  it("asks at every start, even after a profile was picked on the previous start", async () => {
    let mod = await startApp();
    try {
      await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
      expect(mod.profileStore.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null, status: "ready" });
      await mod.profileStore.selectProfile(KIDS.id);
      expect(mod.profileStore.getSnapshot()).toMatchObject({ needsChoice: false, activeId: KIDS.id });
      expect([...storage.keys()]).not.toContain(`sf_active_profile:${USER}`);
      dump("first start done", mod);

      mod = await startApp();
      await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
      dump("second start", mod);
      expect(mod.profileStore.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null });
    } catch (error) {
      dump("failed", mod);
      throw error;
    }
  });

  // @req UX-PROF-01[badger-desktop]
  it("an account with one profile never sees the question", async () => {
    api.listProfiles.mockResolvedValue({ profiles: [CHRIS], maxProfiles: 5 });
    const mod = await startApp();
    await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
    dump("single", mod);
    expect(mod.profileStore.getSnapshot()).toMatchObject({ needsChoice: false, activeId: CHRIS.id });
  });

  // @req ACCT-SQUAD-02[badger-desktop]
  it("points the library at the chosen profile through the bridge, once per change", async () => {
    const mod = await startApp();
    try {
      await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
      await mod.profileStore.selectProfile(KIDS.id);
      await mod.profileStore.refresh();
      await mod.profileStore.selectProfile(CHRIS.id);
      dump("after switches", mod);
      const calls = bridgeSetActiveProfile.mock.calls.map(([profile]) => profile);
      // null while the picker is open, then Kids (kept across the refresh), then Chris.
      expect(calls).toEqual([null, { id: KIDS.id, isMain: false }, { id: CHRIS.id, isMain: true }]);
    } catch (error) {
      dump("failed", mod);
      throw error;
    }
  });

  // @req ACCT-SQUAD-02[badger-desktop]
  it("@bugfix after a library reset clears main's profile, the active profile is sent to main again", async () => {
    api.listProfiles.mockResolvedValue({ profiles: [CHRIS], maxProfiles: 5 });
    const clearLocalCache = vi.fn(async () => undefined);
    vi.stubGlobal("window", { sf: { libraryDb: { setActiveProfile: bridgeSetActiveProfile, clearLocalCache } } });
    const mod = await startApp();
    // After vi.resetModules the store's LibraryDb is a fresh module instance: only a dynamic import reaches that one.
    const { LibraryDb } = await import("../src/renderer/src/lib/libraryDb");
    try {
      await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
      const before = bridgeSetActiveProfile.mock.calls.length;
      expect(bridgeSetActiveProfile).toHaveBeenLastCalledWith({ id: CHRIS.id, isMain: true });
      // OnboardingKey's reset: main forgets the profile (`sf-library-db-clear-local-cache`), the session stays.
      await LibraryDb.clearLocalCache();
      await vi.waitFor(() => expect(bridgeSetActiveProfile).toHaveBeenCalledTimes(before + 1));
      await mod.profileStore.refresh();
      dump("after reset + refresh", mod);
      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      // Sent once more after the reset, and the refresh after it is deduped again.
      expect(bridgeSetActiveProfile.mock.calls.slice(before).map(([p]) => p)).toEqual([{ id: CHRIS.id, isMain: true }]);
    } catch (error) {
      dump("failed", mod);
      throw error;
    }
  });

  /** Main's push when the server refuses the profile named on a playback (STOR-BW-11, `sf-playback-profile-refused`). */
  const refuseWith = (mod: DesktopProfiles) => (code: string) => {
    console.info(`${LOG} playback refused code=${code}`);
    return mod.handlePlaybackProfileRefused(code);
  };

  // @req UX-PROF-01[badger-desktop]
  it("@bugfix a profile deleted on another device is dropped as soon as playback is refused, not at the next focus", async () => {
    const mod = await startApp();
    const refuse = refuseWith(mod);
    try {
      await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
      await mod.profileStore.selectProfile(KIDS.id);
      api.listProfiles.mockResolvedValue({ profiles: [CHRIS], maxProfiles: 5 });
      void refuse("profile_not_owned");
      await vi.waitFor(() => expect(mod.profileStore.getSnapshot()).toMatchObject({ activeId: CHRIS.id, needsChoice: false }));
      dump("after refusal of a deleted profile", mod);
      expect(bridgeSetActiveProfile).toHaveBeenLastCalledWith({ id: CHRIS.id, isMain: true });
    } catch (error) {
      dump("failed", mod);
      throw error;
    }
  });

  // @req UX-PROF-01[badger-desktop]
  it("@bugfix a refused profile still in the list opens Who's watching? once per burst; profile_required asks nothing", async () => {
    const mod = await startApp();
    const refuse = refuseWith(mod);
    try {
      await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
      await mod.profileStore.selectProfile(KIDS.id);
      const listsBefore = api.listProfiles.mock.calls.length;
      await refuse("profile_required");
      expect(api.listProfiles.mock.calls.length).toBe(listsBefore);
      // A segment burst: every in-flight request is refused together.
      const burst = [refuse("profile_not_owned"), refuse("profile_not_owned"), refuse("profile_not_owned")];
      await Promise.all(burst);
      await vi.waitFor(() => expect(mod.profileStore.getSnapshot()).toMatchObject({ activeId: null, needsChoice: true }));
      dump("after refusal burst", mod);
      expect(api.listProfiles.mock.calls.length).toBe(listsBefore + 1);
    } catch (error) {
      dump("failed", mod);
      throw error;
    }
  });

  // @req ACCT-PROF-02[badger-desktop]
  it("deleting a profile runs the attached library's moves; without an open library the delete is refused", async () => {
    const mod = await startApp();
    try {
      await mod.profileStore.startSession({ userId: USER, token: "tok", askEveryStart: true });
      await mod.profileStore.selectProfile(KIDS.id);
      await expect(mod.deleteProfileOnThisDevice(CHRIS.id)).rejects.toMatchObject({ code: "offline" });
      expect(api.deleteProfile).not.toHaveBeenCalled();

      const moves = {
        ensureReady: vi.fn(async () => undefined),
        wipeProfileViewing: vi.fn(async () => undefined),
        promoteProfileToMain: vi.fn(async () => undefined),
        healMainPromotion: vi.fn(async () => undefined),
        listViewingProfileIds: vi.fn(async () => []),
      };
      mod.attachProfileLibrary(moves);
      const promoted: ApiProfile = { ...KIDS, isMain: true };
      api.deleteProfile.mockResolvedValue({ profiles: [promoted], maxProfiles: 5 });
      await mod.deleteProfileOnThisDevice(CHRIS.id);
      dump("after delete", mod);
      expect(moves.ensureReady).toHaveBeenCalled();
      expect(moves.promoteProfileToMain).toHaveBeenCalledWith(KIDS.id);
      expect(mod.profileStore.getSnapshot()).toMatchObject({ activeId: KIDS.id, profiles: [promoted] });
      expect(bridgeSetActiveProfile).toHaveBeenLastCalledWith({ id: KIDS.id, isMain: true });
    } catch (error) {
      dump("failed", mod);
      throw error;
    }
  });
});
