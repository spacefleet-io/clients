/**
 * A song's lyrics as the library keeps them (PAR-LYR-01): synced lyrics as LRC text (`[mm:ss.xx] line`), plain lyrics
 * as text. Shared by the importer (which writes them) and every app (which reads and draws them), so the LRC reading
 * and the "which line is sung now" rule live once.
 */

/** One line of synced lyrics: when it starts (ms from the song's start) and its words. */
export type ParrotLyricLine = { ms: number; text: string };

/**
 * What the Lyrics tab draws: synced lines when the song has them (shown over plain ones), else plain text, else nothing.
 * `fetched`: the words came from our lyrics library (PAR-LYR-05), not from the song's own file (PAR-LYR-01).
 * `notFound`: no words, and the lookup already looked everywhere for them (PAR-LYR-04's final "No lyrics").
 * `searching`: no words yet, and a lookup for the song is queued or running (PAR-LYR-06): never "No lyrics" meanwhile.
 */
export type ParrotLyrics = { synced: ParrotLyricLine[] | null; plain: string | null; fetched: boolean; notFound?: true; searching?: true };

/** What the Lyrics tab draws for a song with no words whose lookup is queued or running (PAR-LYR-06). */
export const PARROT_LYRICS_SEARCHING: ParrotLyrics = { synced: null, plain: null, fetched: false, searching: true };

/** The song's lyrics as read from the library, or the searching state when it has none and a lookup has it pending. */
export const parrotLyricsOrSearching = (lyrics: ParrotLyrics | null, pending: boolean): ParrotLyrics | null =>
  lyrics?.synced || lyrics?.plain ? lyrics : pending ? PARROT_LYRICS_SEARCHING : lyrics;

/**
 * A `lyrics` row as the library keeps it: `source` is "file" for the song's own lyrics, {@link PARROT_LYRICS_FETCHED}
 * for words the lookup found (rows written by older builds may hold another word there: any other value reads as fetched),
 * and {@link PARROT_LYRICS_NOT_FOUND} (no words) once the lookup found none, so it is not asked again on its own.
 */
export type ParrotLyricsRow = { synced: string | null; plain: string | null; source: string | null };

/** The `source` of a row recording that the lyrics lookup found nothing for the song (PAR-LYR-01 automatic lookup). */
export const PARROT_LYRICS_NOT_FOUND = "none";

/** The `source` of a row holding words the lyrics lookup found (META-SRC-09: never the name of where they came from). */
export const PARROT_LYRICS_FETCHED = "fetched";

/** The lyrics of one song (parameter: track id); zero or one row. */
export const TRACK_LYRICS_SQL = "SELECT synced, plain, source FROM lyrics WHERE track_id = ?";

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const ID_TAG = /^\s*\[[a-z]+:[^\]]*\]\s*$/i;

/**
 * Reads LRC text into lines in time order. A line with several time tags (`[00:12.00][01:30.00] chorus`) is repeated at
 * each time; ID tags (`[ar:…]`, `[offset:…]`) and lines with no time tag are left out; `[offset:+/-ms]` shifts every line.
 * Returns null when no timed line is found.
 */
export const parseLrc = (lrc: string): ParrotLyricLine[] | null => {
  const offset = Number(/\[offset:\s*([+-]?\d+)\s*\]/i.exec(lrc)?.[1] ?? 0);
  const lines: ParrotLyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    if (ID_TAG.test(raw)) continue;
    const times = [...raw.matchAll(TIME_TAG)];
    if (times.length === 0) continue;
    const text = raw.replace(TIME_TAG, "").trim();
    for (const [, min, sec, frac = "0"] of times) {
      const fraction = Number(frac.padEnd(3, "0").slice(0, 3));
      lines.push({ ms: Math.max(0, Number(min) * 60_000 + Number(sec) * 1000 + fraction - offset), text });
    }
  }
  if (lines.length === 0) return null;
  return lines.sort((a, b) => a.ms - b.ms);
};

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** Writes timed lines as LRC text (`[mm:ss.xx] words`), the form the library keeps. */
export const toLrc = (lines: readonly ParrotLyricLine[]): string =>
  lines
    .map(({ ms, text }) => {
      const at = Math.max(0, Math.round(ms));
      return `[${pad(Math.floor(at / 60_000), 2)}:${pad(Math.floor((at % 60_000) / 1000), 2)}.${pad(Math.floor((at % 1000) / 10), 2)}] ${text}`.trimEnd();
    })
    .join("\n");

/** The line being sung at `positionMs`: the last one that has started; -1 before the first. */
export const activeLyricIndex = (lines: readonly ParrotLyricLine[], positionMs: number): number => {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid]!.ms <= positionMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};

/** A `lyrics` row as the Lyrics tab needs it; null when the song has none and was never looked up. */
export const toParrotLyrics = (row: ParrotLyricsRow | null | undefined): ParrotLyrics | null => {
  if (!row) return null;
  const synced = row.synced ? parseLrc(row.synced) : null;
  const plain = row.plain?.trim() ? row.plain.trim() : null;
  if (synced || plain) return { synced, plain, fetched: (row.source ?? "file") !== "file" };
  return row.source === PARROT_LYRICS_NOT_FOUND ? { synced: null, plain: null, fetched: true, notFound: true } : null;
};

/** Reads one song's lyrics through any SQLite runner (the phone's, node:sqlite, the browser's). */
export const readParrotLyrics = (all: <T>(sql: string, params: unknown[]) => T[], trackId: string): ParrotLyrics | null =>
  toParrotLyrics(all<ParrotLyricsRow>(TRACK_LYRICS_SQL, [trackId])[0]);
