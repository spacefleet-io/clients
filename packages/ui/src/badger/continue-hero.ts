import { formatBadgerRuntime } from "./components";

export type BadgerContinueHeroText = {
  /** "1926 · 1h 18m · Comedy · Action · 37 min left", empty parts left out. */
  meta: string;
  /** Seconds watched, when the runtime is known. */
  resumeAtSeconds: number | null;
};

/**
 * The hero's meta line and resume point from the title's year, progress and runtime (the longest version's
 * duration). Without a runtime the line keeps the year and genres and Resume shows no time.
 */
export function buildBadgerContinueHeroText(
  item: { year?: string | null; progressPct: number | null },
  runtimeSeconds: number | null,
  genreNames: readonly string[],
  minutesLeftLabel: (minutes: number) => string,
): BadgerContinueHeroText {
  const parts: string[] = [];
  if (item.year) parts.push(item.year);
  const runtime = runtimeSeconds && runtimeSeconds > 0 ? runtimeSeconds : null;
  if (runtime) parts.push(formatBadgerRuntime(runtime));
  parts.push(...genreNames.slice(0, 2));
  let resumeAtSeconds: number | null = null;
  if (runtime) {
    const pct = Math.min(100, Math.max(0, item.progressPct || 0));
    resumeAtSeconds = Math.round((runtime * pct) / 100);
    parts.push(minutesLeftLabel(Math.max(1, Math.round((runtime - resumeAtSeconds) / 60))));
  }
  return { meta: parts.join(" · "), resumeAtSeconds };
}
