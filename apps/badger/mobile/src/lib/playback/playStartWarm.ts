import { findMediaPlacementId } from "@space/shared/mediaPlacement";
import type { MediaDetails } from "@space/shared/libraryTypes";
import type { TrackPrefs } from "@space/shared/trackPrefs";
import { getStoredLibraryKey } from "../onboarding";
import { resolveGatewayCandidates } from "../playbackGateway";
import { peekPlayStartRead, rememberPlayStartRead, scopePlayStartReadsToToken, takePlayStartRead } from "./playStartCache";

const LIBRARY_KEY = "libraryKey";
const gatewayKey = (placementId: string | null) => `gateway:${placementId ?? "-"}`;
const trackPrefsKey = (mediaId: string) => `trackPrefs:${mediaId}`;

// The player JOINS what the details page warmed and otherwise reads afresh without caching: a reload after an error
// must read again, not replay the answer that led to it.

/** The stored library key (Keychain): the details page's read when one is fresh, else a new read. */
export const libraryKeyForPlay = (): Promise<string | null> =>
  peekPlayStartRead<string | null>(LIBRARY_KEY) ?? getStoredLibraryKey();

/** Gateway candidates of one placement under `token`: the details page's lookup when one is fresh, else a new one. */
export const gatewayCandidatesForPlay = (token: string, placementId: string | null): Promise<string[]> => {
  scopePlayStartReadsToToken(token);
  return peekPlayStartRead<string[]>(gatewayKey(placementId)) ?? resolveGatewayCandidates(token, placementId);
};

/**
 * The track prefs the details page read for this title, or null. Used once: a pick made in the player
 * (`setTrackPrefs`) must not be shadowed on the next play by the read taken before it.
 */
export const takeWarmTrackPrefs = (mediaId: string): Promise<TrackPrefs | null> | null =>
  takePlayStartRead<TrackPrefs | null>(trackPrefsKey(mediaId));

/**
 * Opening a title is the first sign of a play: start the reads a play start waits on now (library key, the gateway
 * lookup for the placement Play is likely to use, the title's track prefs), so the tap on Play finds them done or in
 * flight. Fire-and-forget; a failure is dropped from the cache and left for the player's own read to report.
 */
export const warmPlayStart = (input: {
  token: string | null;
  mediaId: string;
  details: Pick<MediaDetails, "type" | "episodes" | "files" | "formats" | "audioTracks" | "subtitleTracks">;
  /** The episode Play would start (the resume target), or null for a film / nothing to resume. */
  episodeId: string | null;
  readTrackPrefs: (mediaId: string) => Promise<TrackPrefs | null>;
}): void => {
  const { token, mediaId, details, episodeId, readTrackPrefs } = input;
  // Scope first: a new token empties the cache, which must not take the reads started just below with it.
  if (token) scopePlayStartReadsToToken(token);
  void rememberPlayStartRead(LIBRARY_KEY, getStoredLibraryKey).catch(() => undefined);
  void rememberPlayStartRead(trackPrefsKey(mediaId), () => readTrackPrefs(mediaId)).catch(() => undefined);
  if (!token) return;
  const placementId = findMediaPlacementId(details, episodeId);
  void rememberPlayStartRead(gatewayKey(placementId), () => resolveGatewayCandidates(token, placementId)).catch(
    () => undefined,
  );
};
