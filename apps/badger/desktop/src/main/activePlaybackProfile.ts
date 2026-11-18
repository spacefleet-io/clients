import { readProfileId } from "@space/shared/playbackProfile";
import { scopeLogger } from "./logger";

const logger = scopeLogger("active-playback-profile");

/**
 * The profile the desktop plays for (STOR-BW-11): the API id of the profile picked at "Who's watching?", the main profile's real
 * id on a single-profile account too. Every playback session names it; null (no profile picked yet, or signed out) makes playback
 * fail with `profile_required` instead of guessing one. Set by the library context when the active profile changes.
 */
let activeProfileId: string | null = null;

export const setActivePlaybackProfileId = (id: string | null) => {
  const next = readProfileId(id);
  if (next === activeProfileId) return;
  logger.info({ event: "active_playback_profile_changed", from: activeProfileId, to: next }, "active_playback_profile_changed");
  activeProfileId = next;
};

export const getActivePlaybackProfileId = (): string | null => activeProfileId;
