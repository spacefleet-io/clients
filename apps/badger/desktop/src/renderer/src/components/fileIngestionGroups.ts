type MatchLike = {
  id: number;
  type: "movie" | "tv";
};

type CandidateLike<TMatch extends MatchLike> = {
  id: string;
  status: string;
  match: TMatch | null;
  parsed?: {
    season?: number | null;
    episode?: number | null;
  } | null;
};

export type FileIngestionEpisodeGroup<TCandidate, TSummary> = TSummary & {
  id: string;
  season: number | null;
  episode: number | null;
  candidates: TCandidate[];
};

export type FileIngestionMergedGroup<TCandidate, TMatch extends MatchLike, TSummary> = Partial<TSummary> & {
  id: string;
  match: TMatch;
  candidates: TCandidate[];
  episodeGroups?: Array<FileIngestionEpisodeGroup<TCandidate, TSummary>>;
};

/**
 * The file's automatic title lookup has not ended yet (queued or running), so it is neither matched nor unmatched:
 * the import shows it as searching, never as "No match found" (INGS-IDENT-02).
 */
export const isLookupInProgress = (candidate: { status: string; match: unknown }): boolean =>
  !candidate.match && (candidate.status === "pending" || candidate.status === "scanning" || candidate.status === "searching");

export const buildFileIngestionMergedGroups = <
  TCandidate extends CandidateLike<TMatch>,
  TMatch extends MatchLike,
  TSummary extends object,
>(
  candidates: TCandidate[],
  summarize: (groupCandidates: TCandidate[]) => TSummary
): Array<FileIngestionMergedGroup<TCandidate, TMatch, TSummary>> => {
  const movieGroups = new Map<string, TCandidate[]>();
  const showGroups = new Map<
    string,
    {
      match: TMatch;
      candidates: TCandidate[];
      episodes: Map<string, { season: number | null; episode: number | null; candidates: TCandidate[] }>;
    }
  >();

  candidates
    .filter((candidate) => candidate.status === "ready" && candidate.match)
    .forEach((candidate) => {
      const match = candidate.match;
      if (!match) return;
      if (match.type === "tv") {
        const showKey = `${match.type}:${match.id}`;
        const show =
          showGroups.get(showKey) ??
          {
            match,
            candidates: [] as TCandidate[],
            episodes: new Map<string, { season: number | null; episode: number | null; candidates: TCandidate[] }>(),
          };
        show.candidates.push(candidate);
        const season = typeof candidate.parsed?.season === "number" ? candidate.parsed.season : null;
        const episode = typeof candidate.parsed?.episode === "number" ? candidate.parsed.episode : null;
        const episodeKey = season !== null && episode !== null ? `s${season}e${episode}` : `unknown-${candidate.id}`;
        const entry = show.episodes.get(episodeKey) ?? { season, episode, candidates: [] as TCandidate[] };
        entry.candidates.push(candidate);
        show.episodes.set(episodeKey, entry);
        showGroups.set(showKey, show);
        return;
      }
      const key = `${match.type}:${match.id}`;
      const list = movieGroups.get(key) ?? [];
      list.push(candidate);
      movieGroups.set(key, list);
    });

  const groups: Array<FileIngestionMergedGroup<TCandidate, TMatch, TSummary>> = [];

  movieGroups.forEach((groupCandidates, key) => {
    const match = groupCandidates[0]?.match;
    if (!match) return;
    groups.push({
      id: key,
      match,
      candidates: groupCandidates,
      ...summarize(groupCandidates),
    });
  });

  showGroups.forEach((show, key) => {
    const episodeGroups: Array<FileIngestionEpisodeGroup<TCandidate, TSummary>> = [];
    show.episodes.forEach((episodeEntry, episodeKey) => {
      episodeGroups.push({
        id: `${key}:${episodeKey}`,
        season: episodeEntry.season,
        episode: episodeEntry.episode,
        candidates: episodeEntry.candidates,
        ...summarize(episodeEntry.candidates),
      });
    });
    episodeGroups.sort((a, b) => {
      const seasonA = a.season ?? Number.MAX_SAFE_INTEGER;
      const seasonB = b.season ?? Number.MAX_SAFE_INTEGER;
      if (seasonA !== seasonB) return seasonA - seasonB;
      const episodeA = a.episode ?? Number.MAX_SAFE_INTEGER;
      const episodeB = b.episode ?? Number.MAX_SAFE_INTEGER;
      if (episodeA !== episodeB) return episodeA - episodeB;
      return a.id.localeCompare(b.id);
    });
    groups.push({
      id: key,
      match: show.match,
      candidates: show.candidates,
      ...summarize(show.candidates),
      episodeGroups,
    });
  });

  return groups;
};

export const buildFileIngestionTvSeasonState = <TEpisodeGroup extends { season: number | null }>(
  episodeGroups: TEpisodeGroup[] | undefined,
  selectedSeasonKey: string | null
) => {
  if (!episodeGroups || episodeGroups.length === 0) {
    return { seasons: [] as string[], activeKey: null as string | null, episodes: [] as TEpisodeGroup[] };
  }
  const seasons = Array.from(
    new Set(episodeGroups.map((episodeGroup) => (episodeGroup.season === null ? "unknown" : String(episodeGroup.season))))
  ).sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return Number(a) - Number(b);
  });
  const activeKey = selectedSeasonKey && seasons.includes(selectedSeasonKey) ? selectedSeasonKey : seasons[0] ?? null;
  const episodes = activeKey
    ? episodeGroups.filter((episodeGroup) => {
        const key = episodeGroup.season === null ? "unknown" : String(episodeGroup.season);
        return key === activeKey;
      })
    : [];
  return { seasons, activeKey, episodes };
};
