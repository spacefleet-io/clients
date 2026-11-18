/**
 * Parrot phone's profiles (ACCT-PROF-01, ACCT-PROF-02, UX-PROF-01): the shared store (`@space/shared/profileStore`,
 * the one Badger's apps use) on AsyncStorage. The phone remembers its pick like Badger's phone; "Who's listening?"
 * opens after the setup and the library key. The active profile names the playback sessions (STOR-BW-11) and keys the
 * listening history on this phone (`profileHistoryStorageKey`); a deleted profile's history goes with it. A delete
 * goes through the API alone (ACCT-PROF-02): the library holds no per-profile data yet, so it need not be open.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import {
  createProfile as apiCreateProfile,
  deleteProfile as apiDeleteProfile,
  listProfiles as apiListProfiles,
  updateProfile as apiUpdateProfile,
} from "@space/shared/api";
import {
  createProfileStore,
  type ProfileLibraryMoves,
  type ProfilesSnapshot,
  type ProfileStoreDeps,
} from "@space/shared/profileStore";
import { setActiveProfile } from "./activeProfile";
import { dropDeletedProfilesHistory } from "./history";

/** The store with Parrot's storage and API; `createParrotProfileStore` lets tests pass their own. */
export const createParrotProfileStore = (deps: Pick<ProfileStoreDeps, "storage" | "api">) => {
  const store = createProfileStore({
    ...deps,
    applyScope: setActiveProfile,
    // A profile deleted here or elsewhere leaves no listening history on this phone.
    reconcileResumeHints: (_mainId, profileIds) => {
      const userId = store.getSnapshot().userId;
      return userId ? dropDeletedProfilesHistory(userId, profileIds) : Promise.resolve();
    },
    // The shared store names its events `profiles.*`; playback imports this module, so no native logger here.
    log: (event, data) => console.info(`parrot.${event}`, JSON.stringify(data)),
  });
  return store;
};

export const profileStore = createParrotProfileStore({
  storage: AsyncStorage,
  api: { list: apiListProfiles, create: apiCreateProfile, update: apiUpdateProfile, remove: apiDeleteProfile },
});

export const useProfiles = (): ProfilesSnapshot =>
  useSyncExternalStore(profileStore.subscribe, profileStore.getSnapshot, profileStore.getSnapshot);

/**
 * What a delete moves in Parrot's library: nothing yet, since playlists and hearts are the account's until they are
 * per profile; the deleted profile's history goes in `reconcileResumeHints`. With nothing to move, a delete needs no
 * open library: a phone without a Parrot library, or with it still opening, deletes like the website (ACCT-PROF-02).
 */
export const parrotProfileMoves: ProfileLibraryMoves = {
  ensureReady: async () => undefined,
  wipeProfileViewing: async () => undefined,
  promoteProfileToMain: async () => undefined,
  healMainPromotion: async () => undefined,
  listViewingProfileIds: async () => [],
};
