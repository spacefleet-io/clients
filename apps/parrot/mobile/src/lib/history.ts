// This phone's listening history for Home (PAR-HOME-01, PAR-HOME-02): what parrot-core's `recordPlay` and
// `recordPosition` keep, stored in AsyncStorage per profile (`profileHistoryStorageKey`, ACCT-PROF-01), never uploaded.
// `historyStep` is the pure part the recorder runs on each player state, so tests read it without the native player.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { historyStorageKey, parseHistory, profileHistoryStorageKey, recordPlay, recordPosition, type ListeningHistory } from "@space/parrot-core";
import type { NowPlayingTitles } from "./nowPlaying";

export type HistoryPlayerState = { mediaId: string | null; positionMs: number; playing: boolean };

/**
 * The history after one player state: a new song records a play (its album first, its artist one more play); the same
 * song, playing or just paused, records its position. A song the phone knows no album for changes nothing.
 */
export const historyStep = (
  history: ListeningHistory,
  previousMediaId: string | null,
  state: HistoryPlayerState,
  titles: ReadonlyMap<string, NowPlayingTitles>,
  now: number,
): ListeningHistory => {
  if (!state.mediaId) return history;
  const meta = titles.get(state.mediaId);
  if (!meta?.albumId) return history;
  const track = { id: state.mediaId, albumId: meta.albumId, artistId: meta.artistId ?? "" };
  if (state.mediaId !== previousMediaId) return recordPlay(history, track, now);
  return recordPosition(history, track, state.positionMs);
};

/** Who the history belongs to: the account and its active profile. */
export type HistoryOwner = { userId: string; profileId: string; isMain: boolean };

/**
 * One profile's history. The main profile adopts the account's history from before profiles (`historyStorageKey`)
 * once, so an update keeps its Home; the old key goes, so no later main profile takes it again.
 */
export const loadHistory = async (owner: HistoryOwner): Promise<ListeningHistory> => {
  const key = profileHistoryStorageKey(owner.userId, owner.profileId);
  const own = await AsyncStorage.getItem(key).catch(() => null);
  if (own !== null || !owner.isMain) return parseHistory(own);
  const legacyKey = historyStorageKey(owner.userId);
  const legacy = await AsyncStorage.getItem(legacyKey).catch(() => null);
  if (legacy === null) return parseHistory(null);
  await AsyncStorage.setItem(key, legacy).catch(() => undefined);
  await AsyncStorage.removeItem(legacyKey).catch(() => undefined);
  return parseHistory(legacy);
};

export const saveHistory = (owner: HistoryOwner, history: ListeningHistory): Promise<void> =>
  AsyncStorage.setItem(profileHistoryStorageKey(owner.userId, owner.profileId), JSON.stringify(history)).catch(() => undefined);

/** Erases the histories of the account's profiles that are gone (deleted here or elsewhere, ACCT-PROF-02). */
export const dropDeletedProfilesHistory = async (userId: string, profileIds: readonly string[]): Promise<void> => {
  const prefix = profileHistoryStorageKey(userId, "");
  const keep = new Set(profileIds.map((id) => profileHistoryStorageKey(userId, id)));
  const keys = await AsyncStorage.getAllKeys();
  const gone = keys.filter((key) => key.startsWith(prefix) && !keep.has(key));
  if (gone.length > 0) await AsyncStorage.multiRemove(gone);
};
