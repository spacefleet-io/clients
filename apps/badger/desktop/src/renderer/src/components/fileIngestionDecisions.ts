import { qualityRank } from "@/lib/labJobs";

type MatchLike = {
  id: number;
  type: "movie" | "tv";
  title: string;
};

type CandidateLike = {
  parsed?: {
    season?: number | null;
    episode?: number | null;
  } | null;
  size: number;
};

type VideoVariantLike<TCandidate> = {
  candidate: TCandidate;
  quality: string;
  codec: string;
  hasChapters: boolean;
};

type TrackSummaryLike<TCandidate> = {
  audioTracks?: unknown[];
  subtitleTracks?: unknown[];
  videoVariants?: Array<VideoVariantLike<TCandidate>>;
};

type EpisodeGroupLike<TCandidate> = TrackSummaryLike<TCandidate> & {
  id: string;
  season: number | null;
  episode: number | null;
  candidates: TCandidate[];
};

type MergedGroupLike<TCandidate, TMatch extends MatchLike> = TrackSummaryLike<TCandidate> & {
  id: string;
  match: TMatch;
  candidates: TCandidate[];
  episodeGroups?: Array<EpisodeGroupLike<TCandidate>>;
};

export type FileIngestionVideoDecisionItem = {
  id: string;
  groupId: string;
  slotId: string;
  title: string;
  slotLabel: string;
  quality: string;
  estimatedSizeMb: number | null;
  existingQualities: string[];
};

type GroupEpisodeSlot<TCandidate> = EpisodeGroupLike<TCandidate>;

export const buildFileIngestionEpisodeSlots = <
  TCandidate extends CandidateLike,
  TMatch extends MatchLike,
>(
  group: MergedGroupLike<TCandidate, TMatch>
): Array<GroupEpisodeSlot<TCandidate>> => {
  if (group.episodeGroups && group.episodeGroups.length > 0) {
    return group.episodeGroups;
  }
  return [
    {
      id: group.id,
      season: group.candidates[0]?.parsed?.season ?? null,
      episode: group.candidates[0]?.parsed?.episode ?? null,
      candidates: group.candidates,
      audioTracks: group.audioTracks ?? [],
      subtitleTracks: group.subtitleTracks ?? [],
      videoVariants: group.videoVariants ?? [],
    },
  ];
};

export const buildFileIngestionVideoDecisionItems = <
  TCandidate extends CandidateLike,
  TMatch extends MatchLike,
>(
  params: {
    groups: Array<MergedGroupLike<TCandidate, TMatch>>;
    hasExistingFiles: (match: TMatch) => boolean;
    getExistingQualities: (match: TMatch, season: number | null, episode: number | null) => Set<string>;
    selectVariants: (variants: Array<VideoVariantLike<TCandidate>>) => Array<VideoVariantLike<TCandidate>>;
    movieLabel: string;
  }
): FileIngestionVideoDecisionItem[] => {
  const { groups, hasExistingFiles, getExistingQualities, selectVariants, movieLabel } = params;
  const items: FileIngestionVideoDecisionItem[] = [];

  groups.forEach((group) => {
    if (!hasExistingFiles(group.match)) return;
    const episodeGroups = buildFileIngestionEpisodeSlots(group);
    episodeGroups.forEach((episodeGroup) => {
      const existingQualities = getExistingQualities(group.match, episodeGroup.season, episodeGroup.episode);
      // New episode of an existing show — no conflict to resolve
      if (existingQualities.size === 0 && episodeGroup.season !== null && episodeGroup.episode !== null) return;
      const selected = selectVariants(episodeGroup.videoVariants ?? []);
      selected.forEach((entry) => {
        if (existingQualities.has(entry.quality)) return;
        const slotLabel =
          episodeGroup.season !== null && episodeGroup.episode !== null
            ? `S${episodeGroup.season}E${String(episodeGroup.episode).padStart(2, "0")}`
            : movieLabel;
        items.push({
          id: `${episodeGroup.id}:${entry.quality}`,
          groupId: group.id,
          slotId: episodeGroup.id,
          title: group.match.title,
          slotLabel,
          quality: entry.quality,
          estimatedSizeMb: entry.candidate.size ? Math.round(entry.candidate.size / (1024 * 1024)) : null,
          existingQualities: Array.from(existingQualities).sort((a, b) => qualityRank(b) - qualityRank(a)),
        });
      });
    });
  });

  return items;
};

export const countFileIngestionAutoIgnoredVideoOverlaps = <
  TCandidate extends CandidateLike,
  TMatch extends MatchLike,
>(
  params: {
    groups: Array<MergedGroupLike<TCandidate, TMatch>>;
    hasExistingFiles: (match: TMatch) => boolean;
    getExistingQualities: (match: TMatch, season: number | null, episode: number | null) => Set<string>;
    selectVariants: (variants: Array<VideoVariantLike<TCandidate>>) => Array<VideoVariantLike<TCandidate>>;
  }
): number => {
  const { groups, hasExistingFiles, getExistingQualities, selectVariants } = params;
  let count = 0;

  groups.forEach((group) => {
    if (!hasExistingFiles(group.match)) return;
    const episodeGroups = buildFileIngestionEpisodeSlots(group);
    episodeGroups.forEach((episodeGroup) => {
      const existingQualities = getExistingQualities(group.match, episodeGroup.season, episodeGroup.episode);
      // New episode of an existing show — no overlap possible
      if (existingQualities.size === 0 && episodeGroup.season !== null && episodeGroup.episode !== null) return;
      const selected = selectVariants(episodeGroup.videoVariants ?? []);
      selected.forEach((entry) => {
        if (existingQualities.has(entry.quality)) count += 1;
      });
    });
  });

  return count;
};
