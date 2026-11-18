/**
 * The desktop app's profile store (ACCT-PROF-01, ACCT-PROF-02, ACCT-SQUAD-02, UX-PROF-01, UX-PROF-02): the shared store
 * (`@space/shared/profileStore`, also used by the phone and TV) on localStorage. The chosen profile goes to the
 * library in the main process through its own bridge channel (`LibraryDb.setActiveProfile`), which main keeps for
 * every library it opens until sign-out. The library context attaches the deletion data moves once a library is open
 * (`attachProfileLibrary`); a delete without one is refused before the API is asked.
 */
import { useSyncExternalStore } from "react";
import { createProfile, deleteProfile, listProfiles, updateProfile } from "@/api";
import { LibraryDb } from "@/lib/libraryDb";
import { rendererLogger } from "@/logger";
import { PLAYBACK_PROFILE_NOT_OWNED_CODE } from "@space/shared/playbackProfile";
import {
  ProfileActionError,
  createProfileStore,
  type ProfileLibraryMoves,
  type ProfilesSnapshot,
} from "@space/shared/profileStore";

export * from "@space/shared/profileStore";

const log = rendererLogger.child({ scope: "profiles" });

/** `id:isMain` of the profile last sent to main; the store emits on every list refresh, main needs only changes. */
let appliedScopeKey: string | null | undefined;

const applyScope = (profile: { id: string; isMain: boolean } | null) => {
  const next = profile ? { id: profile.id, isMain: profile.isMain } : null;
  const key = next ? `${next.id}:${next.isMain}` : null;
  if (key === appliedScopeKey) return;
  appliedScopeKey = key;
  log.info({ profileId: next?.id ?? null, isMain: next?.isMain ?? null }, "profiles.scope.apply");
  void LibraryDb.setActiveProfile(next)
    .then((result) => log.info({ profileId: next?.id ?? null, result }, "profiles.scope.applied"))
    .catch((error: unknown) => {
      // Sent again on the next emit instead of being taken as applied.
      if (appliedScopeKey === key) appliedScopeKey = undefined;
      log.warn({ profileId: next?.id ?? null, err: error }, "profiles.scope.failed");
    });
};

export const profileStore = createProfileStore({
  storage: {
    getItem: async (key) => localStorage.getItem(key),
    setItem: async (key, value) => localStorage.setItem(key, value),
    removeItem: async (key) => localStorage.removeItem(key),
  },
  api: {
    list: listProfiles,
    create: createProfile,
    update: updateProfile,
    remove: deleteProfile,
  },
  applyScope,
  log: (event, data) => log.info(data, event),
});

// A library reset (`LibraryDb.clearLocalCache`, e.g. OnboardingKey's) makes main forget the profile while this session
// goes on: forget what was sent and send the active profile again, or every later emit is skipped as a duplicate.
LibraryDb.onLocalCacheCleared(() => {
  const { activeId, profiles } = profileStore.getSnapshot();
  const active = profiles.find((profile) => profile.id === activeId) ?? null;
  log.info({ profileId: active?.id ?? null }, "profiles.scope.reapply_after_reset");
  appliedScopeKey = undefined;
  applyScope(active);
});

let refusalInFlight = false;

/**
 * STOR-BW-11: the server refused the profile named on a playback (`profile_not_owned`), e.g. it was deleted on another
 * device. Re-reads the list now instead of at the next window focus: a deleted active profile is dropped there (the
 * picker opens, or the one remaining profile is used); one still listed is asked again. The requests of a segment burst
 * are refused together, so a refusal that arrives while one is being handled is skipped. `profile_required` asks
 * nothing: no profile is picked, so "Who's watching?" already covers the app.
 */
export const handlePlaybackProfileRefused = async (code: string) => {
  log.warn({ code, activeId: profileStore.getSnapshot().activeId, handling: refusalInFlight }, "profiles.playback_refused");
  if (code !== PLAYBACK_PROFILE_NOT_OWNED_CODE || refusalInFlight) return;
  refusalInFlight = true;
  const refusedId = profileStore.getSnapshot().activeId;
  try {
    await profileStore.refresh();
    if (refusedId && profileStore.getSnapshot().activeId === refusedId) profileStore.askAgain();
  } finally {
    refusalInFlight = false;
  }
};

let attachedMoves: ProfileLibraryMoves | null = null;

/** The open library's deletion moves (null when it closes); it also finishes an interrupted main-profile move. */
export const attachProfileLibrary = (moves: ProfileLibraryMoves | null) => {
  attachedMoves = moves;
  profileStore.attachLibrary(moves);
};

/** ACCT-PROF-02: deletes a profile and moves its library data; refused (`offline`) while no library is open. */
export const deleteProfileOnThisDevice = async (profileId: string) => {
  if (!attachedMoves) {
    log.warn({ profileId }, "profiles.delete.no_library");
    throw new ProfileActionError("offline");
  }
  await profileStore.deleteProfile(profileId, attachedMoves);
};

export const useProfiles = (): ProfilesSnapshot =>
  useSyncExternalStore(profileStore.subscribe, profileStore.getSnapshot, profileStore.getSnapshot);
