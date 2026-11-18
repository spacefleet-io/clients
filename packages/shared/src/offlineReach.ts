/**
 * What still plays while a device is offline, one rule for Parrot (PAR-OFFL-04) and Badger (OFFL-PLAY-03) on the phone
 * and the computer. Online, everything plays. Offline, an item (a song, a film, an episode) plays only when it is
 * complete on the device, and a collection (an album, a playlist, a show, a season) plays when at least one of its
 * members is. Everything else is greyed out and does not open or play; coming back online lifts the grey at once.
 * Each app owns its storage and its online signal and asks these pure rules.
 */

/** Whether something is greyed out: the device is offline and it is not on the device. */
export const unavailableOffline = (online: boolean, onDevice: boolean): boolean => !online && !onDevice;

/** A collection is on the device when at least one of its members is. */
export const anyOnDevice = (onDevice: ReadonlySet<string>, memberIds: Iterable<string>): boolean => {
  for (const id of memberIds) if (onDevice.has(id)) return true;
  return false;
};

/** The `"season-episode"` key Badger's apps use for an episode. */
export const episodeKey = (seasonNumber: number, episodeNumber: number) => `${seasonNumber}-${episodeNumber}`;

/** Keys of the episodes with at least one file complete on the device (a film's files have no season and are skipped). */
export const episodeKeysOnDevice = (
  files: ReadonlyArray<{ id: string; season: number | null; episode: number | null }>,
  onDevice: (fileId: string) => boolean,
): Set<string> => {
  const keys = new Set<string>();
  for (const file of files) {
    if (file.season == null || file.episode == null) continue;
    if (onDevice(file.id)) keys.add(episodeKey(file.season, file.episode));
  }
  return keys;
};

/**
 * The episodes that may start now: every episode with a file while online; offline, only those also on the device.
 * Returns `withFile` itself online, so a memo keyed on it does not change.
 */
export const playableEpisodeKeysNow = (
  online: boolean,
  withFile: ReadonlySet<string>,
  onDevice: ReadonlySet<string>,
): ReadonlySet<string> => {
  if (online) return withFile;
  const keys = new Set<string>();
  for (const key of withFile) if (onDevice.has(key)) keys.add(key);
  return keys;
};
