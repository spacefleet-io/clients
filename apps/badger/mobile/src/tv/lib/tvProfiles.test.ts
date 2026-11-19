/**
 * @test-id TV-PROFILES-001
 * @level unit
 *
 * The TV app's profile logic, as the TV runs it (`useProfileSession(IS_TV)` → `askEveryStart: true`):
 *  - UX-PROF-02: an account with two profiles is asked "Who's watching?" at every start, even right after the same
 *    TV watched as one of them, and the choice is never saved on the TV,
 *  - UX-PROF-01: the navigator shows "Who's watching?" before the app; picking a profile loads its viewing state and
 *    switching again (Settings → Switch profile) needs no new sign-in; a single profile never sees the question,
 *  - ACCT-PROF-01: the TV refuses a profile past the plan's limit,
 *  - ACCT-PROF-02: any profile goes as long as one remains, the main one included (the oldest remaining one then
 *    reads the library's own storage).
 * The screens themselves are driven by the `tv-profiles` remote e2e scenario (Android TV and Apple TV).
 *
 * @req UX-PROF-02[badger-tv]
 * @req UX-PROF-01[badger-tv]
 * @req ACCT-PROF-01[badger-tv]
 * @req ACCT-PROF-02[badger-tv]
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { ApiError } from "@space/shared/api";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import { resolveNavigatorScreen, type ProfileGate } from "../../navigation/resolveScreen";
import { ACTIVE_PROFILE_KEY, createProfileStore, type ProfilesSnapshot } from "../../lib/profiles/profileStore";

const TAG = "[tv-profiles]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const USER = "tv-user";
const TOKEN = "tv-token";

const profile = (id: string, minute: number): ApiProfile => ({
  id,
  name: id,
  avatar: minute % 8,
  avatarId: "fox" as const,
  createdAt: `2026-10-22T09:${String(minute).padStart(2, "0")}:00.000Z`,
  isMain: minute === 0,
});

type Server = { profiles: ApiProfile[]; maxProfiles: number; signIns: number };

const respond = (server: Server): ProfilesResponse => ({
  profiles: server.profiles.map((p, i) => ({ ...p, isMain: i === 0 })),
  maxProfiles: server.maxProfiles,
});

/** One TV start: a fresh store over the TV's (persistent) storage, as the app builds it at launch. */
const startTv = async (server: Server, storage: Map<string, string>) => {
  const scopes: Array<string | null> = [];
  let seq = 0;
  const store = createProfileStore({
    storage: {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => {
        storage.set(key, value);
      },
      removeItem: async (key) => {
        storage.delete(key);
      },
    },
    api: {
      list: async () => respond(server),
      create: async (_token, body) => {
        if (server.profiles.length >= server.maxProfiles) throw new ApiError(409, { error: "profile_limit" });
        const created = { ...profile(`p${++seq}`, 30 + seq), name: body.name };
        server.profiles = [...server.profiles, created];
        return { ...respond(server), profile: created };
      },
      update: async () => {
        throw new ApiError(500, {});
      },
      remove: async (_token, id) => {
        if (server.profiles.length <= 1) throw new ApiError(409, { error: "last_profile" });
        server.profiles = server.profiles.filter((p) => p.id !== id);
        return respond(server);
      },
    },
    applyScope: (p) => {
      const scope = p ? `${p.id}${p.isMain ? "(main)" : ""}` : null;
      if (scopes[scopes.length - 1] !== scope) scopes.push(scope);
    },
    reconcileResumeHints: async () => undefined,
    log: (event, data) => log(`event ${event}`, data),
  });
  await store.startSession({ userId: USER, token: TOKEN, askEveryStart: true });
  return { store, scopes };
};

const gateOf = (snapshot: ProfilesSnapshot): ProfileGate =>
  snapshot.status === "loading" ? "loading" : snapshot.needsChoice ? "choose" : "ready";

const screenFor = (snapshot: ProfilesSnapshot) =>
  resolveNavigatorScreen({
    authLoading: false,
    user: { id: USER },
    contractIssue: null,
    formatTooNew: false,
    needsKey: false,
    errorReportsAnswered: true,
    initializing: false,
    datasetStatus: { core: true },
    profiles: gateOf(snapshot),
  });

const moves = (done: string[]) => ({
  ensureReady: async () => undefined,
  wipeProfileViewing: async (id: string) => {
    done.push(`wipe:${id}`);
  },
  promoteProfileToMain: async (id: string) => {
    done.push(`promote:${id}`);
  },
  healMainPromotion: async () => undefined,
  listViewingProfileIds: async () => [],
});

describe("TV profiles", () => {
  it("@req UX-PROF-02 asks Who's watching? at every start, never reopening yesterday's profile", async () => {
    const server: Server = { profiles: [profile("chris", 0), profile("kids", 1)], maxProfiles: 5, signIns: 1 };
    const storage = new Map<string, string>();

    const yesterday = await startTv(server, storage);
    log("phase=yesterday-start", { screen: screenFor(yesterday.store.getSnapshot()) });
    expect(screenFor(yesterday.store.getSnapshot())).toBe("profiles");
    await yesterday.store.selectProfile("kids");
    expect(screenFor(yesterday.store.getSnapshot())).toBe("main");
    expect(yesterday.scopes[yesterday.scopes.length - 1]).toBe("kids");
    expect(storage.has(ACTIVE_PROFILE_KEY(USER)), "the TV never saves who watched").toBe(false);

    const today = await startTv(server, storage);
    log("phase=today-start", { screen: screenFor(today.store.getSnapshot()), storage: [...storage.keys()] });
    expect(today.store.getSnapshot()).toMatchObject({ activeId: null, needsChoice: true });
    expect(screenFor(today.store.getSnapshot())).toBe("profiles");
  });

  it("@req UX-PROF-01 switching from Settings asks again and needs no new sign-in; one profile never asks", async () => {
    const server: Server = { profiles: [profile("chris", 0), profile("kids", 1)], maxProfiles: 5, signIns: 1 };
    const tv = await startTv(server, new Map());
    await tv.store.selectProfile("chris");
    tv.store.askAgain();
    expect(screenFor(tv.store.getSnapshot())).toBe("profiles");
    await tv.store.selectProfile("kids");
    log("phase=switched", { scopes: tv.scopes, signIns: server.signIns });
    expect(tv.scopes).toEqual([null, "chris(main)", null, "kids"]);
    expect(server.signIns).toBe(1);

    const single: Server = { profiles: [profile("solo", 0)], maxProfiles: 1, signIns: 1 };
    const alone = await startTv(single, new Map());
    expect(screenFor(alone.store.getSnapshot())).toBe("main");
    alone.store.askAgain();
    expect(screenFor(alone.store.getSnapshot()), "nothing to switch to").toBe("main");
  });

  it("@req ACCT-PROF-01 refuses a profile past the plan's limit (one on free)", async () => {
    const free: Server = { profiles: [profile("solo", 0)], maxProfiles: 1, signIns: 1 };
    const tv = await startTv(free, new Map());
    expect(tv.store.canCreate()).toBe(false);
    await expect(tv.store.createProfile("Kids")).rejects.toMatchObject({ code: "profile_limit" });

    const paid: Server = { profiles: [profile("chris", 0)], maxProfiles: 5, signIns: 1 };
    const paidTv = await startTv(paid, new Map());
    for (const name of ["A", "B", "C", "D"]) await paidTv.store.createProfile(name);
    log("phase=paid-full", paidTv.store.getSnapshot().profiles.map((p) => p.name));
    expect(paidTv.store.getSnapshot().profiles).toHaveLength(5);
    await expect(paidTv.store.createProfile("E")).rejects.toMatchObject({ code: "profile_limit" });
  });

  it("@req ACCT-PROF-02 deletes any profile, the main one included, while one remains", async () => {
    const server: Server = { profiles: [profile("chris", 0), profile("kids", 1)], maxProfiles: 5, signIns: 1 };
    const tv = await startTv(server, new Map());
    await tv.store.selectProfile("kids");
    const done: string[] = [];
    await tv.store.deleteProfile("chris", moves(done));
    log("phase=main-deleted", { done, scopes: tv.scopes, snapshot: tv.store.getSnapshot() });
    expect(done).toEqual(["promote:kids"]);
    expect(tv.store.getSnapshot().profiles.map((p) => [p.id, p.isMain])).toEqual([["kids", true]]);
    expect(tv.scopes[tv.scopes.length - 1]).toBe("kids(main)");
    await expect(tv.store.deleteProfile("kids", moves(done))).rejects.toMatchObject({ code: "last_profile" });
  });
});
