/**
 * @test-id PARROT-MOBILE-PROFILES-001
 * @level unit
 * @req UX-PROF-01[parrot]
 * @req ACCT-PROF-01[parrot]
 * @req ACCT-PROF-02[parrot]
 * @why Parrot's phone asks "Who's listening?" with the shared profile store and screen (Badger's): the phone keeps its
 *   pick until sign-out, each profile has its own listening history on the phone (the main profile adopts the history
 *   from before profiles once), a deleted profile's history goes with it, a delete goes through the API alone (no open
 *   library needed: a paid account without a Parrot library could not delete before), the list is read again when the
 *   app comes back to the front, and playback sessions name the profile that listens. The screens are tried on a
 *   device; this pins the wiring.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyHistory, historyStorageKey, profileHistoryStorageKey, recordPlay } from "@space/parrot-core";
import type { ProfileAvatarId } from "@space/shared/profileAvatars";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import { loadHistory, saveHistory } from "../src/lib/history";
import { activeProfileId } from "../src/lib/activeProfile";
import { NO_LIBRARY_MOVES } from "@space/shared/profileStore";
import { createParrotProfileStore } from "../src/lib/profiles";

// vi.mock is hoisted above the imports; the map it reads must be too.
const { saved } = vi.hoisted(() => ({ saved: new Map<string, string>() }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: async (key: string, value: string) => void saved.set(key, value),
    removeItem: async (key: string) => void saved.delete(key),
    getAllKeys: async () => [...saved.keys()],
    multiRemove: async (keys: string[]) => keys.forEach((key) => saved.delete(key)),
  },
}));


const USER = "user-1";
const profile = (id: string, isMain: boolean, name: string): ApiProfile =>
  ({ id, isMain, name, createdAt: "2026-11-10T00:00:00.000Z" }) as ApiProfile;

const fakeApi = (start: ApiProfile[]) => {
  let profiles = [...start];
  const list = (): ProfilesResponse => ({ profiles, maxProfiles: 5 });
  return {
    list: async () => list(),
    create: async (_token: string, body: { name: string }) => {
      const created = profile(`p${profiles.length + 1}`, false, body.name);
      profiles = [...profiles, created];
      return { ...list(), profile: created };
    },
    update: async (_token: string, id: string, body: { name?: string; avatarId?: ProfileAvatarId }) => {
      profiles = profiles.map((p) => (p.id === id ? { ...p, ...body } : p));
      return { ...list(), profile: profiles.find((p) => p.id === id)! };
    },
    remove: async (_token: string, id: string) => {
      profiles = profiles.filter((p) => p.id !== id);
      return list();
    },
  };
};

const storage = {
  getItem: async (key: string) => saved.get(key) ?? null,
  setItem: async (key: string, value: string) => void saved.set(key, value),
  removeItem: async (key: string) => void saved.delete(key),
};

const played = (albumId: string) => recordPlay(emptyHistory(), { id: `${albumId}-t1`, albumId, artistId: "artist" }, 1);

beforeEach(() => {
  saved.clear();
});

describe("Who's listening? on Parrot's phone", () => {
  it("asks once when the account has two profiles, then reopens the pick until sign-out", async () => {
    const api = fakeApi([profile("main", true, "Chris"), profile("p2", false, "Sam")]);
    const store = createParrotProfileStore({ storage, api });
    await store.startSession({ userId: USER, token: "t", askEveryStart: false });
    expect(store.getSnapshot()).toMatchObject({ status: "ready", needsChoice: true, activeId: null });

    await store.selectProfile("p2");
    expect(store.getSnapshot()).toMatchObject({ needsChoice: false, activeId: "p2" });

    const restarted = createParrotProfileStore({ storage, api });
    await restarted.startSession({ userId: USER, token: "t", askEveryStart: false });
    expect(restarted.getSnapshot()).toMatchObject({ needsChoice: false, activeId: "p2" });

    await restarted.endSession(USER);
    await restarted.startSession({ userId: USER, token: "t", askEveryStart: false });
    expect(restarted.getSnapshot()).toMatchObject({ needsChoice: true, activeId: null });
  });

  it("opens straight on the only profile", async () => {
    const store = createParrotProfileStore({ storage, api: fakeApi([profile("main", true, "Chris")]) });
    await store.startSession({ userId: USER, token: "t", askEveryStart: false });
    expect(store.getSnapshot()).toMatchObject({ needsChoice: false, activeId: "main" });
  });

  it("reads the list again each time the app comes back to the front", () => {
    const session = readFileSync(path.resolve(import.meta.dirname, "../src/state/session.tsx"), "utf8");
    expect(session).toMatch(
      /AppState\.addEventListener\("change", \(status\) => \{\s+if \(status === "active"\) void profileStore\.refresh\(\);/,
    );
  });
});

describe("listening history per profile", () => {
  it("keeps each profile's history apart, and the main profile adopts the account's history once", async () => {
    saved.set(historyStorageKey(USER), JSON.stringify(played("old-album")));
    const main = { userId: USER, profileId: "main", isMain: true };
    const other = { userId: USER, profileId: "p2", isMain: false };

    expect((await loadHistory(main)).albums.map((a) => a.albumId)).toEqual(["old-album"]);
    expect(saved.has(historyStorageKey(USER))).toBe(false);
    expect((await loadHistory(other)).albums).toEqual([]);

    await saveHistory(other, played("sam-album"));
    expect((await loadHistory(other)).albums.map((a) => a.albumId)).toEqual(["sam-album"]);
    expect((await loadHistory(main)).albums.map((a) => a.albumId)).toEqual(["old-album"]);
    expect(saved.has(profileHistoryStorageKey(USER, "p2"))).toBe(true);
  });

  it("deletes through the API with no library open, then the deleted profile's history goes", async () => {
    const store = createParrotProfileStore({ storage, api: fakeApi([profile("main", true, "Chris"), profile("p2", false, "Sam")]) });
    await store.startSession({ userId: USER, token: "t", askEveryStart: false });
    await store.selectProfile("main");
    await saveHistory({ userId: USER, profileId: "p2", isMain: false }, played("sam-album"));
    await saveHistory({ userId: USER, profileId: "main", isMain: true }, played("chris-album"));

    await store.deleteProfile("p2", NO_LIBRARY_MOVES);
    expect(store.getSnapshot().profiles.map((p) => p.id)).toEqual(["main"]);
    expect(saved.has(profileHistoryStorageKey(USER, "p2"))).toBe(false);
    expect(saved.has(profileHistoryStorageKey(USER, "main"))).toBe(true);
  });
});

describe("playback names the listening profile (STOR-BW-11)", () => {
  it("follows the pick, and forgets it at sign-out", async () => {
    const store = createParrotProfileStore({ storage, api: fakeApi([profile("main", true, "Chris"), profile("p2", false, "Sam")]) });
    await store.startSession({ userId: USER, token: "t", askEveryStart: false });
    expect(activeProfileId()).toBeNull();
    await store.selectProfile("p2");
    expect(activeProfileId()).toBe("p2");
    await store.endSession(USER);
    expect(activeProfileId()).toBeNull();
  });
});
