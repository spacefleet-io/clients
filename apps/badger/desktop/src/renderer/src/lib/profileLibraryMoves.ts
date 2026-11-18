/**
 * ACCT-PROF-02 data moves on desktop, run by the device that deletes a profile (the library is end-to-end encrypted, so
 * no server can do it), the same moves the phone and TV run. `ensureReady` and `healMainPromotion` need a sync the
 * server confirmed, exactly like mobile's `syncConfirmed`: the library meta must be `present` (`classifyLibraryMeta`),
 * otherwise they throw. `syncFromRemoteIfNewer` alone answers `false` without an error when sync is unavailable, and a
 * delete or heal on that stale library would replay a move another device already finished. The other moves pull the
 * latest ops first, as the playlist writes do.
 */
import type { LibraryMeta } from "@space/shared/api";
import { classifyLibraryMeta, LibrarySyncUnavailableError } from "@space/shared/libraryMetaState";
import type { ProfileLibraryMoves } from "@space/shared/profileStore";

export type ProfileMovesLibrary = {
  syncFromRemoteIfNewer: (meta?: LibraryMeta) => Promise<boolean>;
  wipeProfileViewing: (profileId: string) => Promise<number>;
  promoteProfileToMain: (newMainId: string) => Promise<unknown>;
  healMainPromotion: (mainId: string) => Promise<boolean>;
  listViewingProfileIds: () => Promise<string[]>;
};

export type ProfileMovesDeps = {
  db: ProfileMovesLibrary;
  token: string | null;
  getLibraryMeta: (token: string) => Promise<LibraryMeta>;
  /** Pulls ops newer than the library (best effort, as before any other write). */
  ensureRemoteFresh: () => Promise<void>;
  /** Re-reads the snapshot after a move changed the library. */
  refreshSnapshot: () => Promise<unknown>;
  log: { info: (data: Record<string, unknown>, event: string) => void; warn: (data: Record<string, unknown>, event: string) => void };
};

export const createProfileLibraryMoves = (deps: ProfileMovesDeps): ProfileLibraryMoves => {
  const { db, log } = deps;

  /** Throws unless the server's meta says the library is `present` and the sync with it went through. */
  const syncConfirmed = async (reason: "ready" | "heal") => {
    const meta = deps.token ? await deps.getLibraryMeta(deps.token) : null;
    const state = meta ? classifyLibraryMeta(meta) : null;
    if (!meta || state !== "present") {
      log.warn({ reason, state, hasToken: Boolean(deps.token) }, "profiles.library.sync_unconfirmed");
      throw new LibrarySyncUnavailableError();
    }
    const changed = await db.syncFromRemoteIfNewer(meta);
    if (changed) await deps.refreshSnapshot();
    return changed;
  };

  return {
    ensureReady: async () => {
      const changed = await syncConfirmed("ready");
      log.info({ changed }, "profiles.library.ready");
    },
    wipeProfileViewing: async (profileId) => {
      await deps.ensureRemoteFresh();
      const blanked = await db.wipeProfileViewing(profileId);
      log.info({ profileId, blanked }, "profiles.library.wiped");
      await deps.refreshSnapshot();
    },
    promoteProfileToMain: async (profileId) => {
      await deps.ensureRemoteFresh();
      await db.promoteProfileToMain(profileId);
      log.info({ profileId }, "profiles.library.promoted");
      await deps.refreshSnapshot();
    },
    healMainPromotion: async (mainId) => {
      await syncConfirmed("heal");
      const healed = await db.healMainPromotion(mainId);
      log.info({ mainId, healed }, "profiles.library.heal");
      if (healed) await deps.refreshSnapshot();
    },
    listViewingProfileIds: () => db.listViewingProfileIds(),
  };
};
