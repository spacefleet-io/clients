/**
 * Desktop's ACCT-PROF-02 data moves (`src/renderer/src/lib/profileLibraryMoves.ts`): a delete and a heal run only on a
 * library the server just confirmed in sync (mobile's `syncConfirmed`). `syncFromRemoteIfNewer` answers `false` without
 * an error when sync is unavailable; a heal on that stale library would replay a main-profile move another device
 * already finished (duplicate playlists, older progress over newer), and a delete would outrun its data move.
 *
 * @req ACCT-PROF-02[badger-desktop]
 */
import { describe, expect, it, vi } from "vitest";
import type { LibraryMeta } from "@space/shared/api";
import { createProfileStore, type ProfileLibraryMoves } from "@space/shared/profileStore";
import type { ApiProfile, ProfilesResponse } from "@space/shared/profiles";
import { createProfileLibraryMoves, type ProfileMovesLibrary } from "../src/renderer/src/lib/profileLibraryMoves";

const LOG = "[profiles-library-moves]";

const PRESENT = { exists: true, bootstrapRequired: false, version: 12 } as unknown as LibraryMeta;
const UNAVAILABLE = { exists: false, bootstrapRequired: false, syncUnavailable: true, version: 12 } as unknown as LibraryMeta;

const setup = (options: { meta?: LibraryMeta | Error; token?: string | null } = {}) => {
  const events: string[] = [];
  const db: ProfileMovesLibrary = {
    syncFromRemoteIfNewer: vi.fn(async () => {
      events.push("db.sync");
      return false;
    }),
    wipeProfileViewing: vi.fn(async (id: string) => {
      events.push(`db.wipe:${id}`);
      return 1;
    }),
    promoteProfileToMain: vi.fn(async (id: string) => {
      events.push(`db.promote:${id}`);
      return null;
    }),
    healMainPromotion: vi.fn(async (id: string) => {
      events.push(`db.heal:${id}`);
      return true;
    }),
    listViewingProfileIds: vi.fn(async () => []),
  };
  const meta = options.meta ?? PRESENT;
  const getLibraryMeta = vi.fn(async (token: string) => {
    events.push(`meta:${token}`);
    if (meta instanceof Error) throw meta;
    return meta;
  });
  const logged: Array<{ event: string; data: Record<string, unknown> }> = [];
  const moves = createProfileLibraryMoves({
    db,
    token: options.token === undefined ? "tok" : options.token,
    getLibraryMeta,
    ensureRemoteFresh: async () => void events.push("fresh"),
    refreshSnapshot: async () => void events.push("snapshot"),
    log: {
      info: (data, event) => void logged.push({ event, data }),
      warn: (data, event) => void logged.push({ event, data }),
    },
  });
  const dump = (label: string) => console.info(`${LOG} ${label}`, JSON.stringify({ events, logged }));
  return { db, moves, events, logged, dump, getLibraryMeta };
};

describe("desktop profile data moves need a confirmed sync (ACCT-PROF-02)", () => {
  it("@bugfix sync unavailable: ensureReady and heal throw and never touch the library", async () => {
    const t = setup({ meta: UNAVAILABLE });
    try {
      await expect(t.moves.ensureReady()).rejects.toThrow("LIBRARY_SYNC_UNAVAILABLE");
      await expect(t.moves.healMainPromotion("p-kids")).rejects.toThrow("LIBRARY_SYNC_UNAVAILABLE");
      t.dump("unavailable");
      expect(t.db.syncFromRemoteIfNewer).not.toHaveBeenCalled();
      expect(t.db.healMainPromotion).not.toHaveBeenCalled();
      expect(t.logged.filter((l) => l.event === "profiles.library.sync_unconfirmed")).toHaveLength(2);
    } catch (error) {
      t.dump("failed");
      throw error;
    }
  });

  it("@bugfix the meta request failing, or no token, also refuses", async () => {
    const offline = setup({ meta: new TypeError("fetch failed") });
    await expect(offline.moves.ensureReady()).rejects.toThrow("fetch failed");
    await expect(offline.moves.healMainPromotion("p-kids")).rejects.toThrow("fetch failed");
    offline.dump("meta failed");
    expect(offline.db.healMainPromotion).not.toHaveBeenCalled();

    const signedOut = setup({ token: null });
    await expect(signedOut.moves.ensureReady()).rejects.toThrow("LIBRARY_SYNC_UNAVAILABLE");
    signedOut.dump("no token");
    expect(signedOut.getLibraryMeta).not.toHaveBeenCalled();
    expect(signedOut.db.syncFromRemoteIfNewer).not.toHaveBeenCalled();
  });

  it("a present library syncs with that meta, then heals", async () => {
    const t = setup();
    await t.moves.ensureReady();
    await t.moves.healMainPromotion("p-kids");
    t.dump("present");
    expect(t.db.syncFromRemoteIfNewer).toHaveBeenCalledWith(PRESENT);
    expect(t.events).toEqual(["meta:tok", "db.sync", "meta:tok", "db.sync", "db.heal:p-kids", "snapshot"]);
  });

  it("@bugfix a delete on a library whose sync is unavailable is refused before the API is asked", async () => {
    const t = setup({ meta: UNAVAILABLE });
    const chris = { id: "p-chris", name: "Chris", avatar: 0, avatarId: "raccoon" as const, isMain: true, createdAt: "2026-10-01T00:00:00.000Z" } as ApiProfile;
    const kids = { id: "p-kids", name: "Kids", avatar: 1, avatarId: "fox" as const, isMain: false, createdAt: "2026-10-02T00:00:00.000Z" } as ApiProfile;
    const list: ProfilesResponse = { profiles: [chris, kids], maxProfiles: 5 };
    const remove = vi.fn(async () => ({ profiles: [kids], maxProfiles: 5 }));
    const store = createProfileStore({
      storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
      api: { list: async () => list, create: vi.fn(), update: vi.fn(), remove },
      applyScope: () => undefined,
      log: (event, data) => console.info(`${LOG} store ${event}`, JSON.stringify(data)),
    });
    await store.startSession({ userId: "u1", token: "tok", askEveryStart: true });
    await store.selectProfile(kids.id);
    await expect(store.deleteProfile(chris.id, t.moves as ProfileLibraryMoves)).rejects.toMatchObject({ code: "offline" });
    t.dump("delete refused");
    expect(remove).not.toHaveBeenCalled();
    expect(t.db.promoteProfileToMain).not.toHaveBeenCalled();
  });
});
