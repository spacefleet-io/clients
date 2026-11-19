/**
 * When Badger shows "Your profile" (UX-SETUP-10) and "New in this update" (UX-UPDATE-01), phone and TV. The phone's
 * first setup asks "Your profile" as a numbered step after the key and "Who's watching?"; otherwise (a profile picked
 * later, the TV) the navigator shows it on its own screen right after the profile is picked. An older profile gets the
 * update window instead, once every question is behind it.
 */
import { activeProfileNeedsSetup, useUpdateFeatures, type UpdateFeatures } from "@space/mobile-shell/profile-setup";
import type { ApiProfile } from "@space/shared/profiles";
import { profileStore, useProfiles } from "./profiles/profileStore";

/** The phone setup's check (`askProfileSetupInSetup`): counted while not known yet, as the title question is. */
export const profileSetupAskedInSetup = (): boolean => activeProfileNeedsSetup(profileStore.getSnapshot()) !== false;

/** The navigator's standalone step: shown only once known to be needed. */
export const useProfileSetupQuestion = (): boolean => activeProfileNeedsSetup(useProfiles()) === true;

/** The profile picked, null while "Who's watching?" is open or the list is not known. */
export const useActiveProfile = (): ApiProfile | null => {
  const { profiles, activeId, needsChoice } = useProfiles();
  return needsChoice ? null : (profiles.find(({ id }) => id === activeId) ?? null);
};

/** The update windows of the profile picked; none while `enabled` is false (signed out, setup still running). */
export const useBadgerUpdateFeatures = (enabled: boolean): UpdateFeatures & { profile: ApiProfile | null } => {
  const active = useActiveProfile();
  const profile = enabled ? active : null;
  return { ...useUpdateFeatures(profile), profile };
};
