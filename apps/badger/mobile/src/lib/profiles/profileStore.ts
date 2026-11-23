/**
 * The phone and TV apps' profile store (ACCT-PROF-01, ACCT-PROF-02, ACCT-SQUAD-02, UX-PROF-01, UX-PROF-02): the shared
 * store (`@space/shared/profileStore`, also used by desktop) on AsyncStorage, pointing LibraryDb at the chosen
 * profile's viewing state and moving the device-local resume hints with it.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import {
  createProfile as apiCreateProfile,
  deleteProfile as apiDeleteProfile,
  listProfiles as apiListProfiles,
  updateProfile as apiUpdateProfile,
} from "@space/shared/api";
import { createProfileStore, type ProfilesSnapshot } from "@space/shared/profileStore";
import { viewingScopeFor } from "@space/shared/profileViewing";
import { reconcileResumeHints } from "../resume";
import { setViewingScope } from "./activeViewingScope";

export * from "@space/shared/profileStore";

export const profileStore = createProfileStore({
  storage: AsyncStorage,
  api: {
    list: apiListProfiles,
    create: apiCreateProfile,
    update: apiUpdateProfile,
    remove: apiDeleteProfile,
  },
  applyScope: (profile) => setViewingScope(viewingScopeFor(profile)),
  reconcileResumeHints,
  log: (event, data) => console.info(event, JSON.stringify(data)),
});

export const useProfiles = (): ProfilesSnapshot =>
  useSyncExternalStore(profileStore.subscribe, profileStore.getSnapshot, profileStore.getSnapshot);
