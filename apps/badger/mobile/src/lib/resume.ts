import AsyncStorage from "@react-native-async-storage/async-storage";
import { bumpLibraryRevision } from "./libraryRevision";
import { getViewingScope } from "./profiles/activeViewingScope";

const RESUME_EPISODE_PREFIX = "sf:resume:episode:";

/** The main profile the bare hints belong to on this device (set by `reconcileResumeHints`). */
export const RESUME_HINTS_MAIN_KEY = "sf:resume:main";

/**
 * Device-local "last played episode" hint of a show, kept per profile (ACCT-SQUAD-02): the main profile keeps today's
 * key, any other profile prefixes it with its `p:<profileId>:`, so one profile's episode never becomes another's
 * "Continue" target.
 */
export const lastPlayedEpisodeKey = (mediaId: string, prefix = getViewingScope().prefix) =>
  `${RESUME_EPISODE_PREFIX}${prefix}${mediaId}`;

export const getLastPlayedEpisodeId = async (mediaId: string): Promise<string | null> => {
  try {
    return await AsyncStorage.getItem(lastPlayedEpisodeKey(mediaId));
  } catch {
    return null;
  }
};

export const setLastPlayedEpisodeId = async (
  mediaId: string,
  episodeId: string | null
): Promise<void> => {
  const key = lastPlayedEpisodeKey(mediaId);
  try {
    if (!episodeId) {
      await AsyncStorage.removeItem(key);
      return;
    }
    await AsyncStorage.setItem(key, episodeId);
  } catch {
    // Ignore cache writes; playback still works without resume hints.
  } finally {
    bumpLibraryRevision();
  }
};

type HintStorage = Pick<typeof AsyncStorage, "getAllKeys" | "getItem" | "setItem" | "removeItem">;

/**
 * ACCT-PROF-02, after every fresh profile list: the hints follow profile deletions on this device, whichever device
 * deleted. Hints of a profile no longer in `profileIds` are removed. When the main profile changed since the last
 * list, the bare hints (the deleted main's) are dropped and the new main's `p:<mainId>:` hints take their place.
 * The first list on a device only records `mainId`. Idempotent.
 */
export const reconcileResumeHints = async (
  mainId: string,
  profileIds: readonly string[],
  storage: HintStorage = AsyncStorage
): Promise<void> => {
  const known = new Set(profileIds);
  const previousMain = await storage.getItem(RESUME_HINTS_MAIN_KEY);
  const promoted = previousMain !== null && previousMain !== mainId;
  const mainPrefix = `${RESUME_EPISODE_PREFIX}p:${mainId}:`;
  const keys = (await storage.getAllKeys()).filter((key) => key.startsWith(RESUME_EPISODE_PREFIX));
  let removed = 0;
  const moves: string[] = [];
  // Removals first: a moved hint lands on a bare key that may be in `keys` too.
  for (const key of keys) {
    const rest = key.slice(RESUME_EPISODE_PREFIX.length);
    const bare = !rest.startsWith("p:");
    if (promoted && key.startsWith(mainPrefix)) {
      moves.push(key);
    } else if (bare ? promoted : !known.has(rest.slice(2, rest.indexOf(":", 2)))) {
      await storage.removeItem(key);
      removed += 1;
    }
  }
  for (const key of moves) {
    const value = await storage.getItem(key);
    if (value) await storage.setItem(`${RESUME_EPISODE_PREFIX}${key.slice(mainPrefix.length)}`, value);
    await storage.removeItem(key);
  }
  if (previousMain !== mainId) await storage.setItem(RESUME_HINTS_MAIN_KEY, mainId);
  if (promoted || removed > 0) {
    console.info("resume.hints.reconciled", JSON.stringify({ mainId, previousMain, promoted, moved: moves.length, removed }));
  }
};
