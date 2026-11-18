import type { MediaDetails } from "@/lib/libraryDb";

type MediaDetailsGetter = (mediaId: string) => MediaDetails | null;
type MediaDetailsFetcher = (mediaId: string) => Promise<MediaDetails | null>;

export const resolveSelectedMediaDetails = async (
  mediaId: string,
  getMediaDetails: MediaDetailsGetter,
  fetchMediaDetails: MediaDetailsFetcher
) => {
  return getMediaDetails(mediaId) ?? (await fetchMediaDetails(mediaId));
};
