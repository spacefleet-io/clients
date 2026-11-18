import type { MediaEpisode, MediaRow } from "./libraryTypes";

/**
 * The player's "what's playing" line (PLAY-OVL-01), shared by every SpaceBadger player: "Lodgers · S1 E1 · The New
 * Lodger" for an episode (no name part when the episode has none), "Slow Burn (1995)" for a movie, the title
 * alone without a year, and "" before the title's details are known.
 */
export const formatNowPlaying = (
  media: Pick<MediaRow, "type" | "title" | "year"> | null | undefined,
  episode: Pick<MediaEpisode, "seasonNumber" | "episodeNumber" | "name"> | null | undefined,
): string => {
  if (!media) return "";
  if (episode) {
    const name = episode.name?.trim();
    return [media.title, `S${episode.seasonNumber} E${episode.episodeNumber}`, name].filter(Boolean).join(" · ");
  }
  const year = /^\d{4}/.exec(media.year ?? "")?.[0];
  return year ? `${media.title} (${year})` : media.title;
};

const yearOf = (value: string | null | undefined): string | undefined => /^\d{4}/.exec(value ?? "")?.[0];

/**
 * The desktop player's two-line top band (MPV-OSC-04): the title alone, then a meta line — the year for a movie
 * ("1927"), "S1 · E3 “The Signal” · 2024" for an episode (the year of its air date, else the show's; no name part
 * when the episode has none). The player appends the runtime. Both "" before the title's details are known.
 */
export const formatNowPlayingParts = (
  media: Pick<MediaRow, "type" | "title" | "year"> | null | undefined,
  episode: Pick<MediaEpisode, "seasonNumber" | "episodeNumber" | "name" | "airDate"> | null | undefined,
): { title: string; meta: string } => {
  if (!media) return { title: "", meta: "" };
  if (episode) {
    const name = episode.name?.trim();
    const meta = [
      `S${episode.seasonNumber} · E${episode.episodeNumber}${name ? ` “${name}”` : ""}`,
      yearOf(episode.airDate) ?? yearOf(media.year),
    ];
    return { title: media.title, meta: meta.filter(Boolean).join(" · ") };
  }
  return { title: media.title, meta: yearOf(media.year) ?? "" };
};
