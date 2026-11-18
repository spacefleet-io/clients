/**
 * The profile listening now (ACCT-PROF-01), set by the profile store (`profiles.ts`) and read by playback, which names
 * it in its sessions (STOR-BW-11). Kept apart from the store so playback pulls in no storage.
 */
import type { ApiProfile } from "@space/shared/profiles";

let active: ApiProfile | null = null;

export const setActiveProfile = (profile: ApiProfile | null): void => {
  active = profile;
};

export const activeProfileId = (): string | null => active?.id ?? null;
