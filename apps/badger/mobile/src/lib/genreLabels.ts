import type { MediaType } from "@space/shared/libraryTypes";

/** Genre ids with a translation under `details.genres.<movie|tv>.<id>`; others are not shown. */
const MOVIE_GENRE_IDS: ReadonlySet<number> = new Set([
  28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37,
]);

const TV_GENRE_IDS: ReadonlySet<number> = new Set([
  10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37,
]);

/** i18n key of a genre's name, or null when the genre has no translation (it is then left out of the UI). */
export const genreLabelKey = (type: MediaType, id: number): string | null => {
  const known = type === "tv" ? TV_GENRE_IDS : MOVIE_GENRE_IDS;
  return known.has(id) ? `details.genres.${type === "tv" ? "tv" : "movie"}.${id}` : null;
};
