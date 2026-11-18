import type { LibrarySnapshot } from "@/lib/libraryDb";

/**
 * Whose view a cached snapshot is (UX-PROF-01): progress, continue-watching and playlists differ per profile, so a
 * profile opens only on its own cached view, never on the previous profile's.
 */
export type LibrarySnapshotCacheScope = { userId: string; profileId: string };

const userKeyPrefix = (userId: string) => `sf_library_snapshot_${userId}`;
// Profile ids never hold ':' (the set-active-profile IPC refuses them), so `user:profile` cannot collide.
const snapshotKey = ({ userId, profileId }: LibrarySnapshotCacheScope) => `${userKeyPrefix(userId)}:${profileId}`;

export const parseLibrarySnapshotCache = (raw: string | null): LibrarySnapshot | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LibrarySnapshot>;
    if (!parsed || !Array.isArray(parsed.media) || !Array.isArray(parsed.playlists)) return null;
    return {
      media: parsed.media,
      playlists: parsed.playlists,
      playlistItems: parsed.playlistItems ?? {},
      mediaDetails: Array.isArray(parsed.mediaDetails) ? parsed.mediaDetails : [],
      ingestJobs: Array.isArray(parsed.ingestJobs) ? parsed.ingestJobs : [],
      settings: parsed.settings ?? {},
    } as LibrarySnapshot;
  } catch {
    return null;
  }
};

export const loadLibrarySnapshotCache = (
  scope: LibrarySnapshotCacheScope,
  storage: Pick<Storage, "getItem"> = localStorage
) => parseLibrarySnapshotCache(storage.getItem(snapshotKey(scope)));

export const saveLibrarySnapshotCache = (
  scope: LibrarySnapshotCacheScope,
  snapshot: LibrarySnapshot,
  storage: Pick<Storage, "setItem"> = localStorage
) => {
  try {
    storage.setItem(snapshotKey(scope), JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures.
  }
};

/** Drops every cached view of this user: each profile's, and the per-user one older builds wrote. */
export const clearLibrarySnapshotCache = (
  userId: string,
  storage: Pick<Storage, "removeItem" | "key" | "length"> = localStorage
) => {
  try {
    const legacyKey = userKeyPrefix(userId);
    const profilePrefix = `${legacyKey}:`;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === legacyKey || key?.startsWith(profilePrefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
};
