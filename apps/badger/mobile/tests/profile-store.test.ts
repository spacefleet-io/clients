/**
 * @test-id MOBILE-PROFILE-STORE-001
 * @level unit
 *
 * The profile store shared by the phone and TV apps, driven with a fake API, fake storage and a recorded viewing
 * scope:
 *  - UX-PROF-01: the phone asks "Who's watching?" at sign-in only, then reopens the chosen profile; switching is one
 *    step with no sign-in; signing out forgets the choice; a single profile never asks,
 *  - the TV (askEveryStart) asks at every start and never saves the choice (UX-PROF-02's rule for TV),
 *  - ACCT-PROF-01: the API's limit is shown before the API is even asked, and an API refusal is reported,
 *  - ACCT-PROF-02: deleting the last profile is refused; deleting the main profile promotes the oldest remaining one,
 *    deleting another wipes its viewing state; a profile deleted elsewhere makes the app ask again, and its viewing
 *    data is erased by the next app that opens the library (never a profile the API still lists),
 *  - offline, the saved list keeps working,
 *  - ACCT-PROF-05: a chosen avatar id is sent and kept; a list from before the avatar pack reads colours as avatars.
 *
 * @req UX-PROF-01[badger-mobile]
 * @req ACCT-PROF-01[badger-mobile]
 * @req ACCT-PROF-02[badger-mobile]
 * @req ACCT-PROF-05[badger-mobile]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { ApiError } from "@space/shared/api";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import type { ProfileAvatarId } from "@space/shared/profileAvatars";
import {
  ACTIVE_PROFILE_KEY,
  PROFILES_CACHE_KEY,
  ProfileActionError,
  createProfileStore,
  resolveStartChoice,
} from "../src/lib/profiles/profileStore";

const TAG = "[profile-store]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const USER = "user-1";
const TOKEN = "token-1";

const profile = (id: string, minute: number, isMain = false): ApiProfile => ({
  id,
  name: id.toUpperCase(),
  avatar: minute % 8,
  avatarId: "fox" as const,
  createdAt: `2026-10-22T10:${String(minute).padStart(2, "0")}:00.000Z`,
  isMain,
});

/** A fake API holding the account's profile list (oldest first, main = first), with a limit. */
const fakeApi = (initial: ApiProfile[], maxProfiles = 5) => {
  let profiles = [...initial];
  let offline = false;
  let seq = 0;
  const calls: string[] = [];
  const response = (): ProfilesResponse => ({
    profiles: profiles.map((p, i) => ({ ...p, isMain: i === 0 })),
    maxProfiles,
  });
  const guard = (call: string) => {
    calls.push(call);
    if (offline) throw new TypeError("Network request failed");
  };
  return {
    calls,
    setOffline: (value: boolean) => {
      offline = value;
    },
    /** Another device changes the list. */
    serverSide: {
      remove: (id: string) => {
        profiles = profiles.filter((p) => p.id !== id);
      },
      add: (p: ApiProfile) => {
        profiles = [...profiles, p];
      },
    },
    api: {
      list: async (token: string) => {
        guard(`list:${token}`);
        return response();
      },
      create: async (_token: string, body: { name: string; avatarId?: ProfileAvatarId }) => {
        guard(`create:${body.name}${body.avatarId ? `:${body.avatarId}` : ""}`);
        if (profiles.length >= maxProfiles) throw new ApiError(409, { error: "profile_limit" });
        const created = { ...profile(`new${++seq}`, 50 + seq), ...body };
        profiles = [...profiles, created];
        return { ...response(), profile: created };
      },
      update: async (_token: string, id: string, body: { name?: string; avatarId?: ProfileAvatarId }) => {
        guard(`update:${id}:${JSON.stringify(body)}`);
        const found = profiles.find((p) => p.id === id);
        if (!found) throw new ApiError(404, { error: "profile_not_found" });
        profiles = profiles.map((p) => (p.id === id ? { ...p, ...body } : p));
        return { ...response(), profile: { ...found, ...body } };
      },
      remove: async (_token: string, id: string) => {
        guard(`delete:${id}`);
        if (profiles.length <= 1) throw new ApiError(409, { error: "last_profile" });
        profiles = profiles.filter((p) => p.id !== id);
        return response();
      },
    },
  };
};

const makeStore = (api: ReturnType<typeof fakeApi>, storage = new Map<string, string>()) => {
  const scopes: Array<string | null> = [];
  const hints: string[] = [];
  const store = createProfileStore({
    storage: {
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: async (key: string) => {
        storage.delete(key);
      },
    },
    api: api.api,
    applyScope: (p) => {
      const scope = p ? `${p.id}${p.isMain ? "(main)" : ""}` : null;
      if (scopes[scopes.length - 1] !== scope) scopes.push(scope);
    },
    reconcileResumeHints: async (mainId, ids) => {
      hints.push(`${mainId}:${ids.join(",")}`);
    },
    log: (event, data) => log(`event ${event}`, data),
  });
  return { store, storage, scopes, hints };
};

const moves = (options: { ready?: () => Promise<void>; viewing?: string[] } = {}) => {
  const done: string[] = [];
  return {
    done,
    moves: {
      ensureReady: async () => {
        done.push("ready");
        await options.ready?.();
      },
      wipeProfileViewing: async (id: string) => {
        done.push(`wipe:${id}`);
      },
      promoteProfileToMain: async (id: string) => {
        done.push(`promote:${id}`);
      },
      healMainPromotion: async (id: string) => {
        done.push(`heal:${id}`);
      },
      listViewingProfileIds: async () => options.viewing ?? [],
    },
  };
};

const ADA = profile("ada", 0, true);
const BOB = profile("bob", 1);
const CAL = profile("cal", 2);

describe("resolveStartChoice", () => {
  it("@req UX-PROF-01 decides who opens at start", () => {
    const cases = [
      { profiles: [], rememberedId: null, askEveryStart: true },
      { profiles: [ADA], rememberedId: null, askEveryStart: true },
      { profiles: [ADA, BOB], rememberedId: "bob", askEveryStart: true },
      { profiles: [ADA, BOB], rememberedId: "bob", askEveryStart: false },
      { profiles: [ADA, BOB], rememberedId: null, askEveryStart: false },
      { profiles: [ADA, BOB], rememberedId: "gone", askEveryStart: false },
    ];
    const results = cases.map((c) => resolveStartChoice(c));
    log("cases", results);
    expect(results.map((r) => [r.activeId, r.needsChoice, r.reason])).toEqual([
      [null, false, "no_profiles"],
      ["ada", false, "single"],
      [null, true, "ask_every_start"],
      ["bob", false, "remembered"],
      [null, true, "first_choice"],
      [null, true, "remembered_deleted"],
    ]);
  });
});

describe("phone: asks at sign-in only (UX-PROF-01)", () => {
  let api: ReturnType<typeof fakeApi>;
  beforeEach(() => {
    api = fakeApi([ADA, BOB]);
  });

  it("@req UX-PROF-01 the first start asks, the choice is kept, and the next start reopens it without asking", async () => {
    const first = makeStore(api);
    await first.store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    log("phase=first-start", first.store.getSnapshot());
    expect(first.store.getSnapshot()).toMatchObject({ status: "ready", needsChoice: true, activeId: null });
    await first.store.selectProfile("bob");
    expect(first.storage.get(ACTIVE_PROFILE_KEY(USER))).toBe("bob");
    expect(first.scopes).toEqual([null, "bob"]);

    const second = makeStore(api, first.storage);
    await second.store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    log("phase=second-start", second.store.getSnapshot());
    expect(second.store.getSnapshot()).toMatchObject({ needsChoice: false, activeId: "bob" });
    expect(second.scopes).toEqual(["bob"]);
  });

  it("@req UX-PROF-01 switching is one step, with no sign-in call", async () => {
    const { store, scopes } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("ada");
    const before = [...api.calls];
    await store.selectProfile("bob");
    log("phase=switch", { calls: api.calls, scopes });
    expect(api.calls).toEqual(before);
    expect(store.getSnapshot().activeId).toBe("bob");
    expect(scopes[scopes.length - 1]).toBe("bob");
  });

  it("@req UX-PROF-01 signing out forgets the choice so the next sign-in asks again", async () => {
    const { store, storage } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("bob");
    await store.endSession(USER);
    log("phase=signed-out", { storage: [...storage.keys()], snapshot: store.getSnapshot() });
    expect(storage.has(ACTIVE_PROFILE_KEY(USER))).toBe(false);
    expect(storage.has(PROFILES_CACHE_KEY(USER))).toBe(false);
    expect(store.getSnapshot()).toMatchObject({ status: "idle", activeId: null, profiles: [] });
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    expect(store.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null });
  });

  it("@req UX-PROF-01 an account with one profile never asks", async () => {
    const single = fakeApi([ADA]);
    const { store, scopes } = makeStore(single);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    log("phase=single", store.getSnapshot());
    expect(store.getSnapshot()).toMatchObject({ needsChoice: false, activeId: "ada" });
    expect(scopes).toEqual([null, "ada(main)"]);
  });

  it("@req ACCT-PROF-02 a remembered profile deleted on another device makes the app ask again", async () => {
    const { store, storage } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("bob");
    api.serverSide.add(CAL);
    api.serverSide.remove("bob");
    const next = makeStore(api, storage);
    await next.store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    log("phase=remembered-gone", next.store.getSnapshot());
    expect(next.store.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null });
    expect(next.store.getSnapshot().profiles.map((p) => p.id)).toEqual(["ada", "cal"]);
    // While the app runs: the active profile disappears on refresh.
    await next.store.selectProfile("cal");
    api.serverSide.remove("cal");
    await next.store.refresh();
    expect(next.store.getSnapshot()).toMatchObject({ needsChoice: false, activeId: "ada" });
  });

  it("@req UX-PROF-01 offline, the saved list keeps working and the remembered profile opens", async () => {
    const { store, storage } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("bob");
    api.setOffline(true);
    const offline = makeStore(api, storage);
    await offline.store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    log("phase=offline", offline.store.getSnapshot());
    expect(offline.store.getSnapshot()).toMatchObject({ status: "ready", stale: true, activeId: "bob", needsChoice: false });
    expect(offline.store.getSnapshot().profiles.map((p) => p.id)).toEqual(["ada", "bob"]);
    await expect(offline.store.createProfile("Eve")).rejects.toMatchObject({ code: "offline" });
  });

  it("offline at the very first start, nothing saved: the library's own state opens (no profiles yet)", async () => {
    api.setOffline(true);
    const { store, scopes } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    log("phase=offline-first", store.getSnapshot());
    expect(store.getSnapshot()).toMatchObject({ status: "ready", stale: true, needsChoice: false, activeId: null });
    expect(scopes).toEqual([null]);
  });
});

describe("TV: asks at every start", () => {
  it("@req UX-PROF-01 never reopens a profile by itself and never saves the choice", async () => {
    const api = fakeApi([ADA, BOB]);
    const tv = makeStore(api);
    await tv.store.startSession({ userId: USER, token: TOKEN, askEveryStart: true });
    expect(tv.store.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null });
    await tv.store.selectProfile("bob");
    log("phase=tv-picked", { storage: [...tv.storage.entries()] });
    expect(tv.storage.has(ACTIVE_PROFILE_KEY(USER))).toBe(false);
    const again = makeStore(api, tv.storage);
    await again.store.startSession({ userId: USER, token: TOKEN, askEveryStart: true });
    expect(again.store.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null });
    // Switching from Settings opens the picker again.
    await again.store.selectProfile("ada");
    again.store.askAgain();
    expect(again.store.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null });
  });
});

describe("limits and deletion (ACCT-PROF-01, ACCT-PROF-02)", () => {
  it("@req ACCT-PROF-01 a full account is refused before the API is asked; an API refusal is reported", async () => {
    const api = fakeApi([ADA, BOB], 2);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: true });
    expect(store.canCreate()).toBe(false);
    await expect(store.createProfile("Eve")).rejects.toMatchObject({ code: "profile_limit" });
    expect(api.calls.some((c) => c.startsWith("create:"))).toBe(false);

    // The saved list is stale (another device filled the account): the API refuses and the list is refreshed.
    const raced = fakeApi([ADA], 2);
    const racer = makeStore(raced);
    await racer.store.startSession({ userId: USER, token: TOKEN, askEveryStart: true });
    raced.serverSide.add(BOB);
    await expect(racer.store.createProfile("Eve")).rejects.toBeInstanceOf(ProfileActionError);
    log("phase=raced", { calls: raced.calls, snapshot: racer.store.getSnapshot() });
    expect(racer.store.getSnapshot().profiles.map((p) => p.id)).toEqual(["ada", "bob"]);
  });

  it("@req ACCT-PROF-01 creating and renaming update the list; blank names are refused", async () => {
    const api = fakeApi([ADA]);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    const created = await store.createProfile("  Eve  ");
    expect(created.name).toBe("Eve");
    await store.editProfile(created.id, { name: "Evelyn" });
    log("phase=created", store.getSnapshot().profiles);
    expect(store.getSnapshot().profiles.map((p) => p.name)).toEqual(["ADA", "Evelyn"]);
    await expect(store.createProfile("   ")).rejects.toMatchObject({ code: "invalid_profile" });
    await expect(store.editProfile("nope", { name: "X" })).rejects.toMatchObject({ code: "profile_not_found" });
  });

  it("@req ACCT-PROF-05 a chosen avatar is sent on create and edit and kept in the list", async () => {
    const api = fakeApi([ADA]);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    const created = await store.createProfile("Eve", "owl");
    expect(created.avatarId).toBe("owl");
    await store.editProfile(created.id, { avatarId: "rocket" });
    log("phase=avatars", { calls: api.calls, profiles: store.getSnapshot().profiles });
    expect(api.calls).toContain("create:Eve:owl");
    expect(api.calls).toContain(`update:${created.id}:{"avatarId":"rocket"}`);
    expect(store.getSnapshot().profiles.find((p) => p.id === created.id)).toMatchObject({ name: "Eve", avatarId: "rocket" });
    await expect(store.editProfile(created.id, {})).rejects.toMatchObject({ code: "invalid_profile" });
  });

  it("@req ACCT-PROF-05 a list saved or answered before the avatar pack reads each colour as its avatar", async () => {
    const storage = new Map<string, string>();
    const { avatarId: _dropped, ...oldAda } = { ...ADA, avatar: 3 };
    storage.set(PROFILES_CACHE_KEY(USER), JSON.stringify({ profiles: [oldAda], maxProfiles: 5 }));
    const api = fakeApi([ADA]);
    api.setOffline(true);
    const { store } = makeStore(api, storage);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    log("phase=old-cache", store.getSnapshot().profiles);
    expect(store.getSnapshot().profiles[0]).toMatchObject({ id: ADA.id, avatar: 3, avatarId: "frog" });
  });

  it("@req ACCT-PROF-02 the last profile cannot be deleted", async () => {
    const api = fakeApi([ADA]);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    const m = moves();
    await expect(store.deleteProfile("ada", m.moves)).rejects.toMatchObject({ code: "last_profile" });
    expect(m.done).toEqual([]);
    expect(api.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  it("@req ACCT-PROF-02 deleting another profile wipes its viewing state; the active one keeps playing", async () => {
    const api = fakeApi([ADA, BOB, CAL]);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("ada");
    const m = moves();
    await store.deleteProfile("cal", m.moves);
    log("phase=deleted-other", { done: m.done, snapshot: store.getSnapshot() });
    expect(m.done).toEqual(["ready", "wipe:cal"]);
    expect(store.getSnapshot()).toMatchObject({ activeId: "ada", needsChoice: false });
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(["ada", "bob"]);
  });

  it("@req ACCT-PROF-02 deleting the main profile promotes the oldest remaining one, which then reads the main storage", async () => {
    const api = fakeApi([ADA, BOB, CAL]);
    const { store, scopes } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("bob");
    const m = moves();
    await store.deleteProfile("ada", m.moves);
    log("phase=deleted-main", { done: m.done, scopes, snapshot: store.getSnapshot() });
    expect(m.done).toEqual(["ready", "promote:bob"]);
    expect(store.getSnapshot().profiles.map((p) => [p.id, p.isMain])).toEqual([
      ["bob", true],
      ["cal", false],
    ]);
    expect(store.getSnapshot().activeId).toBe("bob");
    expect(scopes.slice(-2)).toEqual(["bob", "bob(main)"]);
  });

  it("@req ACCT-PROF-02 @bugfix with a stale list, deleting the profile the server holds as main still promotes the next one", async () => {
    const api = fakeApi([ADA, BOB, CAL]);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("cal");
    // The phone deletes Ada (main) and finishes the move; this device never refreshes and still shows Bob as non-main.
    api.serverSide.remove("ada");
    log("phase=stale-list", { local: store.getSnapshot().profiles.map((p) => [p.id, p.isMain]) });
    expect(store.getSnapshot().profiles.find((p) => p.id === "bob")?.isMain).toBe(false);
    const m = moves();
    await store.deleteProfile("bob", m.moves);
    log("phase=deleted-stale-main", { done: m.done, snapshot: store.getSnapshot() });
    expect(m.done).toEqual(["ready", "promote:cal"]);
    expect(store.getSnapshot().profiles.map((p) => [p.id, p.isMain])).toEqual([["cal", true]]);
  });

  it("@req ACCT-PROF-02 deleting the profile in use asks who watches next (or opens the only one left)", async () => {
    const api = fakeApi([ADA, BOB, CAL]);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("cal");
    await store.deleteProfile("cal", moves().moves);
    expect(store.getSnapshot()).toMatchObject({ activeId: null, needsChoice: true });
    await store.selectProfile("bob");
    await store.deleteProfile("bob", moves().moves);
    log("phase=deleted-active", store.getSnapshot());
    expect(store.getSnapshot()).toMatchObject({ activeId: "ada", needsChoice: false });
  });

  it("@req ACCT-PROF-02 @bugfix a library that is not open and fresh refuses the delete before the API is asked", async () => {
    const api = fakeApi([ADA, BOB]);
    const { store } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    const m = moves({
      ready: async () => {
        throw new Error("LIBRARY_NOT_READY");
      },
    });
    await expect(store.deleteProfile("ada", m.moves)).rejects.toMatchObject({ code: "offline" });
    log("phase=refused-not-ready", { done: m.done, calls: api.calls });
    expect(m.done).toEqual(["ready"]);
    expect(api.calls.some((c) => c.startsWith("delete:"))).toBe(false);
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(["ada", "bob"]);
  });

  it("@req ACCT-PROF-02 @bugfix every fresh list asks the open library to finish the main profile's move", async () => {
    const api = fakeApi([ADA, BOB, CAL]);
    const { store } = makeStore(api);
    const m = moves();
    store.attachLibrary(m.moves);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await vi.waitFor(() => expect(m.done).toContain("heal:ada"));
    // Deleted on another device, whose move never ran: the next fresh list hands the job to this one.
    api.serverSide.remove("ada");
    await store.refresh();
    await vi.waitFor(() => expect(m.done).toContain("heal:bob"));
    // Offline: the saved list is not fresh, nothing is moved.
    api.setOffline(true);
    const before = m.done.length;
    await store.refresh();
    log("phase=heal", { done: m.done });
    expect(m.done.length).toBe(before);
    // A detached library (closed, signed out) is never asked.
    store.attachLibrary(null);
    api.setOffline(false);
    await store.refresh();
    expect(m.done.length).toBe(before);
  });

  it("@req ACCT-PROF-02 a profile deleted on the website has its viewing data erased by the next app that opens the library", async () => {
    // The library holds data for bob (live), cal (deleted on the website) and dan (created on another device after
    // this device's list): only cal is erased, because dan shows up when the API is asked again before any wipe.
    const api = fakeApi([ADA, BOB, CAL]);
    api.serverSide.remove("cal");
    const { store } = makeStore(api);
    const m = moves({ viewing: ["bob", "cal", "dan"] });
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    api.serverSide.add(profile("dan", 3));
    store.attachLibrary(m.moves);
    await vi.waitFor(() => expect(m.done).toContain("wipe:cal"));
    log("phase=heal-deleted-elsewhere", { done: m.done, calls: api.calls });
    expect(m.done.filter((d) => d.startsWith("wipe:"))).toEqual(["wipe:cal"]);
    expect(api.calls.filter((c) => c.startsWith("list:")).length).toBeGreaterThanOrEqual(2);
  });

  it("@req ACCT-PROF-02 nothing is erased while every profile holding data is still listed", async () => {
    const api = fakeApi([ADA, BOB]);
    const { store } = makeStore(api);
    const m = moves({ viewing: ["bob"] });
    store.attachLibrary(m.moves);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await vi.waitFor(() => expect(m.done).toContain("heal:ada"));
    const lists = api.calls.filter((c) => c.startsWith("list:")).length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(m.done.some((d) => d.startsWith("wipe:"))).toBe(false);
    expect(api.calls.filter((c) => c.startsWith("list:")).length).toBe(lists);
  });

  it("@req ACCT-PROF-02 @bugfix every fresh list, and only a fresh one, reconciles the device's resume hints", async () => {
    const api = fakeApi([ADA, BOB, CAL]);
    const { store, hints } = makeStore(api);
    await store.startSession({ userId: USER, token: TOKEN, askEveryStart: false });
    await store.selectProfile("bob");
    await store.deleteProfile("ada", moves().moves);
    api.setOffline(true);
    await store.refresh();
    log("phase=hints", hints);
    expect(hints).toEqual(["ada:ada,bob,cal", "bob:bob,cal"]);
  });
});
