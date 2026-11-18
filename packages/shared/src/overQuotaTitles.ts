/**
 * Over-quota titles (ACCT-OVER-01/04): `GET /account/over-quota` lists media placements, never titles (the server
 * cannot read the encrypted library), so each app names them from its own library. A placement no library title
 * holds any more (or a legacy key) stays unnamed and is shown as such. Platform-free (REL-FAM-02): the desktop app
 * uses it today, the phone and TV apps will for ACCT-OVER-01.
 */
import { mediaPlacementUnits } from "./mediaPlacement";
import type { MediaDetails, MediaEpisode } from "./libraryTypes";

export type OverQuotaPlacement = { placementId: string; bytes: number };

export type OverQuotaTitle<P extends OverQuotaPlacement = OverQuotaPlacement> = P & {
  details: MediaDetails | null;
  episode: MediaEpisode | null;
};

/**
 * Walks the library one title at a time and stops once every placement asked for is named, so a big library is not
 * read whole when the few titles at risk are among the newest.
 */
export const nameOverQuotaPlacements = async <P extends OverQuotaPlacement>(
  placements: P[],
  mediaIds: string[],
  fetchDetails: (mediaId: string) => Promise<MediaDetails | null>
): Promise<Array<OverQuotaTitle<P>>> => {
  const wanted = new Set(placements.map((item) => item.placementId));
  const found = new Map<string, { details: MediaDetails; episode: MediaEpisode | null }>();
  for (const mediaId of mediaIds) {
    if (found.size === wanted.size) break;
    const details = await fetchDetails(mediaId);
    if (!details) continue;
    for (const [placementId, episodeId] of mediaPlacementUnits(details)) {
      if (!wanted.has(placementId) || found.has(placementId)) continue;
      found.set(placementId, { details, episode: details.episodes.find((ep) => ep.id === episodeId) ?? null });
    }
  }
  return placements.map((item) => ({ ...item, details: found.get(item.placementId)?.details ?? null, episode: found.get(item.placementId)?.episode ?? null }));
};
