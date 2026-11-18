import type { EpisodeMoveSuggestion, ShowEpisodeSlot } from "@space/shared/libraryTypes";

/**
 * LIB-SHOW-04: where a delisted episode that has a file likely went in TMDB's new episode list.
 *
 * Spec reading (library.md, LIB-SHOW-04 notes): a likely new place is exactly one episode in TMDB's new list that
 * has no file in the library and either has the same title (in any season, Season 0 included) or holds the same
 * position after a renumbering (same air date and order). With no such episode, or more than one, the suggestion is
 * keep-or-pick-by-hand. An episode that already has a file is never a likely place. When TMDB merged two episodes
 * the user has files for into one, each part gets the keep-or-pick-by-hand choice and the dialog says so.
 */

export type EpisodeForMatch = ShowEpisodeSlot & { airDate: string | null; hasFile: boolean };

/** Title compared case-, accent-, punctuation- and spacing-blind. "" for a title that names nothing. */
export const normalizeEpisodeTitle = (title: string): string => {
  const plain = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  // The `Episode N` placeholder of a file TMDB did not know names no episode.
  if (/^(episode|episodio|épisode|folge|aflevering) \d+$/u.test(plain) || /^\d+$/u.test(plain)) return "";
  return plain;
};

// "(1)", "[2]", "Part 1", "Pt. II", "Partie 2", "Teil 2", "Parte 1", optionally after ",", ":" or "-".
const PART_SUFFIX =
  /\s*[,:\-–—]?\s*(?:\(\s*(?:part\s+|pt\.?\s*)?(\d+|[ivx]+|one|two|three)\s*\)|\[\s*(\d+|[ivx]+)\s*\]|(?:part|pt\.?|partie|teil|parte)\s*(\d+|[ivx]+|one|two|three|un|deux|trois))\s*$/iu;

/** The title without a trailing part marker, or null when it has none. */
export const episodeTitleBase = (title: string): string | null => {
  if (!PART_SUFFIX.test(title)) return null;
  const base = normalizeEpisodeTitle(title.replace(PART_SUFFIX, ""));
  return base === "" ? null : base;
};

const slot = (episode: ShowEpisodeSlot): ShowEpisodeSlot => ({
  id: episode.id,
  seasonNumber: episode.seasonNumber,
  episodeNumber: episode.episodeNumber,
  title: episode.title,
});

const byNumber = (a: ShowEpisodeSlot, b: ShowEpisodeSlot) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber;

/**
 * The suggestion for every delisted episode with a file, by episode id.
 * `delisted`: stored episodes TMDB provably no longer lists (with and without a file).
 * `listed`: stored episodes at a slot TMDB's answer lists (after the refresh added the new ones).
 */
export const suggestEpisodeMoves = (
  delisted: EpisodeForMatch[],
  listed: EpisodeForMatch[]
): Map<string, EpisodeMoveSuggestion> => {
  const free = listed.filter((episode) => !episode.hasFile).sort(byNumber);
  const withFile = delisted.filter((episode) => episode.hasFile).sort(byNumber);

  // Same position after a renumbering: the k-th delisted episode of an air day goes to the k-th free listed episode
  // of that day, only when both lists of that day are the same length (otherwise the order says nothing).
  const delistedByDay = new Map<string, EpisodeForMatch[]>();
  for (const episode of [...delisted].sort(byNumber)) {
    if (!episode.airDate) continue;
    delistedByDay.set(episode.airDate, [...(delistedByDay.get(episode.airDate) ?? []), episode]);
  }
  const freeByDay = new Map<string, EpisodeForMatch[]>();
  for (const episode of free) {
    if (!episode.airDate) continue;
    freeByDay.set(episode.airDate, [...(freeByDay.get(episode.airDate) ?? []), episode]);
  }
  const positionMatch = (episode: EpisodeForMatch): EpisodeForMatch | null => {
    if (!episode.airDate) return null;
    const day = delistedByDay.get(episode.airDate) ?? [];
    const targets = freeByDay.get(episode.airDate) ?? [];
    if (day.length === 0 || day.length !== targets.length) return null;
    return targets[day.findIndex((other) => other.id === episode.id)] ?? null;
  };

  const likely = new Map<string, EpisodeForMatch | null>();
  for (const episode of withFile) {
    const title = normalizeEpisodeTitle(episode.title);
    const candidates = new Map<string, EpisodeForMatch>();
    if (title !== "") {
      for (const target of free) if (normalizeEpisodeTitle(target.title) === title) candidates.set(target.id, target);
    }
    const byPosition = positionMatch(episode);
    if (byPosition) candidates.set(byPosition.id, byPosition);
    likely.set(episode.id, candidates.size === 1 ? [...candidates.values()][0]! : null);
  }

  // Merges: two or more parts pointing to the same single place, or sharing a title base ("X (1)", "X (2)") that is
  // the title of exactly one free listed episode.
  const mergedInto = new Map<string, { into: EpisodeForMatch; partIds: string[] }>();
  const partsByTarget = new Map<string, EpisodeForMatch[]>();
  for (const episode of withFile) {
    const target = likely.get(episode.id);
    if (target) partsByTarget.set(target.id, [...(partsByTarget.get(target.id) ?? []), episode]);
  }
  const partsByBase = new Map<string, EpisodeForMatch[]>();
  for (const episode of withFile) {
    const base = episodeTitleBase(episode.title);
    if (base) partsByBase.set(base, [...(partsByBase.get(base) ?? []), episode]);
  }
  for (const [base, parts] of partsByBase) {
    if (parts.length < 2) continue;
    const targets = free.filter((target) => {
      const title = normalizeEpisodeTitle(target.title);
      return title === base || episodeTitleBase(target.title) === base;
    });
    if (targets.length !== 1) continue;
    const into = targets[0]!;
    partsByTarget.set(into.id, [...new Map([...(partsByTarget.get(into.id) ?? []), ...parts].map((p) => [p.id, p])).values()]);
  }
  for (const [targetId, parts] of partsByTarget) {
    if (parts.length < 2) continue;
    const into = free.find((episode) => episode.id === targetId)!;
    const partIds = parts.sort(byNumber).map((part) => part.id);
    for (const part of parts) mergedInto.set(part.id, { into, partIds });
  }

  const out = new Map<string, EpisodeMoveSuggestion>();
  for (const episode of withFile) {
    const merge = mergedInto.get(episode.id);
    if (merge) {
      out.set(episode.id, { kind: "merged", into: slot(merge.into), partIds: merge.partIds });
      continue;
    }
    const target = likely.get(episode.id);
    out.set(episode.id, target ? { kind: "move", target: slot(target) } : { kind: "none" });
  }
  return out;
};
