/** Past this share a title counts as finished and leaves Continue watching. */
export const CONTINUE_WATCHING_MAX_PCT = 95;

/**
 * Every Badger app's Continue watching titles (phone and TV rail, web player hero): started and not finished, the one
 * watched last first.
 */
export const continueWatchingTitles = <T extends { progressPct: number; lastWatchedAt: string | null }>(items: readonly T[]): T[] =>
  items
    .filter((item) => item.progressPct > 0 && item.progressPct < CONTINUE_WATCHING_MAX_PCT)
    .sort((a, b) => ((a.lastWatchedAt ?? "") < (b.lastWatchedAt ?? "") ? 1 : -1));
