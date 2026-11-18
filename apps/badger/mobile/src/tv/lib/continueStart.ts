import type { MediaDetails, MediaRow } from "@space/shared/libraryTypes";
import { playEpisode, uploadedEpisodeKeys } from "../../lib/playback/episodeSelection";
import type { RootStackParamList } from "../../navigation/AppNavigator";

type PlayerParams = RootStackParamList["Player"];

/**
 * The player route for Home's Resume / Start over (UX-TV-05): a film plays itself; a show plays the episode its Play
 * button would (the last one played, else the first with a file), so the card and the title page agree.
 */
export const continuePlayerParams = async (
  item: MediaRow,
  startAt: "resume" | "startOver",
  getMediaDetails: (mediaId: string, options?: { chunks?: boolean }) => Promise<MediaDetails | null>,
  getLastPlayedEpisodeId: (mediaId: string) => Promise<string | null>,
): Promise<PlayerParams> => {
  const base = { mediaId: item.id, backdropPath: item.backdropPath, posterPath: item.posterPath, startAt };
  if (item.type !== "tv") return { ...base, episodeId: null };
  const [details, savedEpisodeId] = await Promise.all([getMediaDetails(item.id, { chunks: false }), getLastPlayedEpisodeId(item.id)]);
  const target = playEpisode(details, savedEpisodeId, uploadedEpisodeKeys(details));
  return { ...base, episodeId: target?.id ?? null };
};
