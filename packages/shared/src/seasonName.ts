/**
 * A season's name on a show's Seasons tab (LIB-DETAIL-01). The metadata service stores the generic names in English ("Specials",
 * "Season 3") whatever the interface language, so a French library read "Season 1" next to "Fichiers manquants": a
 * missing or generic name reads in the interface language, a season's own name ("The Final Chapter") stays as stored.
 */
const GENERIC_SEASON_NAME = /^(season\s+\d+|specials)$/i;

export const seasonDisplayName = (
  seasonNumber: number,
  storedName: string | null | undefined,
  /** `specials`: season 0's name; `season`: "Season {{season}}" filled for this season. */
  labels: { specials: string; season: string }
) => {
  const name = (storedName ?? "").trim();
  if (name && !GENERIC_SEASON_NAME.test(name)) return name;
  return seasonNumber === 0 ? labels.specials : labels.season;
};
