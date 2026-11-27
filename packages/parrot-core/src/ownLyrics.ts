/**
 * The user's own lyrics (PAR-LYR-08..11): a `.lrc`/`.txt` file placed in the import review or words typed in the lyrics
 * editor, kept in the library as a `lyrics.set` row with source {@link PARROT_LYRICS_USER}. Every app reads files,
 * matches them to songs, times lines and plans the ops through this module, so a file means the same thing on the
 * desktop, the web and the phone.
 *
 * The file format is plain LRC (Chris, 2026-11-27): `[mm:ss.xx] words` lines, the header tags `[ar:]`, `[ti:]`,
 * `[al:]`, `[length:]` and `[offset:]`; a file with no time tag (or a `.txt`) holds plain lyrics. Kept LRC carries the
 * song's `[ar:] [al:] [ti:] [length:]`, so a file written from it matches its song again.
 */
import { createParrotOp, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { parrotComparableName } from "./importMatch";
import { PARROT_LYRICS_USER, toLrc, type ParrotLyricLine, type ParrotLyrics } from "./lyrics";

/** The largest lyrics file read (PAR-LYR-10): a song's words are a few KB; anything bigger is not a lyrics file. */
export const PARROT_LYRICS_FILE_MAX_BYTES = 256 * 1024;

/** The file names a drop takes as lyrics (PAR-LYR-09). */
export const isParrotLyricsFileName = (name: string): boolean => /\.(lrc|txt)$/i.test(name);

/**
 * Why a lyrics file (or the editor's text) cannot be kept as is; `line` is 1-based in the user's text.
 * `tooBig`: over {@link PARROT_LYRICS_FILE_MAX_BYTES}. `empty`: no words. `badTime`: a time tag that is not mm:ss(.xx).
 * `untimedLine`: words with no time in a file whose other lines are timed. `outOfOrder`: a line timed before the line
 * above it, never reordered on the user's behalf (PAR-LYR-10).
 */
export type ParrotLyricsProblem = { kind: "tooBig" | "empty" } | { kind: "badTime" | "untimedLine" | "outOfOrder"; line: number };

/** What a lyrics file's header says about its song; any field can be missing. */
export type ParrotLyricsFileTags = { artist: string | null; title: string | null; album: string | null; lengthMs: number | null };

/** A read lyrics file: the words to keep (synced or plain), its header, and what stops it from being kept (none: keep it). */
export type ParrotLyricsFile = {
  synced: ParrotLyricLine[] | null;
  plain: string | null;
  tags: ParrotLyricsFileTags;
  problems: ParrotLyricsProblem[];
};

const TAG = /^\s*\[([a-z]+):([^\]]*)\]\s*$/i;
const LEADING_BRACKETS = /^\s*((?:\[[^\]]*\]\s*)+)/;
const BRACKET = /\[([^\]]*)\]/g;
const TIME = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/;
const WORD_TIME = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

const timeMs = (value: string): number | null => {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  const [, min, sec, frac = "0"] = match;
  if (Number(sec) >= 60) return null;
  return Number(min) * 60_000 + Number(sec) * 1000 + Number(frac.padEnd(3, "0").slice(0, 3));
};

/** One line of the user's text: its words (time tags and word tags taken out) and the times it starts at; `bad`: a time tag it could not read. */
type ReadLine = { line: number; text: string; times: number[]; bad: boolean; tag: [string, string] | null };

const readLine = (raw: string, line: number): ReadLine => {
  const header = TAG.exec(raw);
  if (header && !/^\d+$/.test(header[1]!)) return { line, text: "", times: [], bad: false, tag: [header[1]!.toLowerCase(), header[2]!.trim()] };
  const lead = LEADING_BRACKETS.exec(raw);
  const times: number[] = [];
  let bad = false;
  if (lead) {
    for (const [, inside] of lead[1]!.matchAll(BRACKET)) {
      const ms = timeMs(inside!);
      if (ms === null) bad = true;
      else times.push(ms);
    }
  }
  const words = (lead ? raw.slice(lead[0].length) : raw).replace(WORD_TIME, "").replace(/\s+/g, " ").trim();
  return { line, text: words, times, bad, tag: null };
};

const UTF8 = new TextEncoder();

/**
 * Reads a dropped lyrics file (PAR-LYR-09, PAR-LYR-10). Lines are LRC when any line carries a time tag: then every line
 * with words needs one, times must not go back, and `[offset:]` shifts them all; a line with several times (a chorus)
 * is shown at each. A `.txt` file, or a file with no time tag, is plain lyrics. Word-by-word `<mm:ss.xx>` tags are
 * dropped (the Lyrics tab lights whole lines).
 */
export const parseParrotLyricsFile = (text: string, name = ""): ParrotLyricsFile => {
  const tags: ParrotLyricsFileTags = { artist: null, title: null, album: null, lengthMs: null };
  const nothing = (problems: ParrotLyricsProblem[]): ParrotLyricsFile => ({ synced: null, plain: null, tags, problems });
  if (UTF8.encode(text).length > PARROT_LYRICS_FILE_MAX_BYTES) return nothing([{ kind: "tooBig" }]);
  const raw = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (/\.txt$/i.test(name)) {
    const plain = raw.join("\n").trim();
    return plain ? { synced: null, plain, tags, problems: [] } : nothing([{ kind: "empty" }]);
  }
  const lines = raw.map((value, index) => readLine(value, index + 1));
  let offset = 0;
  for (const { tag } of lines) {
    if (!tag) continue;
    const [key, value] = tag;
    if (key === "ar") tags.artist = value || null;
    else if (key === "ti") tags.title = value || null;
    else if (key === "al") tags.album = value || null;
    else if (key === "length") tags.lengthMs = timeMs(value);
    else if (key === "offset" && /^[+-]?\d+$/.test(value)) offset = Number(value);
  }
  const body = lines.filter((line) => !line.tag);
  const timed = body.some((line) => line.times.length > 0 || line.bad);
  if (!timed) {
    const plain = body
      .map((line) => line.text)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return plain ? { synced: null, plain, tags, problems: [] } : nothing([{ kind: "empty" }]);
  }
  const problems: ParrotLyricsProblem[] = [];
  const synced: ParrotLyricLine[] = [];
  let previous = -1;
  for (const line of body) {
    if (line.bad) {
      problems.push({ kind: "badTime", line: line.line });
      continue;
    }
    if (line.times.length === 0) {
      if (line.text) problems.push({ kind: "untimedLine", line: line.line });
      continue;
    }
    const first = Math.min(...line.times);
    if (first < previous) problems.push({ kind: "outOfOrder", line: line.line });
    previous = Math.max(previous, first);
    for (const ms of line.times) synced.push({ ms: Math.max(0, ms - offset), text: line.text });
  }
  if (problems.length > 0) return nothing(problems);
  if (!synced.some((line) => line.text)) return nothing([{ kind: "empty" }]);
  // Several times on one line put it at each of them: that order is the file's own, not a reordering.
  synced.sort((a, b) => a.ms - b.ms);
  return { synced, plain: plainOf(synced), tags, problems: [] };
};

/** The plain words of synced lyrics, kept next to them so a reader without timing still has the words. */
const plainOf = (lines: readonly ParrotLyricLine[]): string =>
  lines
    .map((line) => line.text)
    .filter(Boolean)
    .join("\n");

/** A song a dropped file can be matched to. */
export type ParrotLyricsSong = { id: string; title: string; artist: string | null; album: string | null; durationMs: number | null };

/** Where a file goes: one song, several equally likely ones (the user picks), or none found (the user picks). */
export type ParrotLyricsMatch = { kind: "matched"; trackId: string } | { kind: "ambiguous"; trackIds: string[] } | { kind: "unmatched" };

/** The tolerance on `[length:]` when it tells apart songs with the same names (a file's length is rounded to the second). */
const LENGTH_TOLERANCE_MS = 3000;

/** The names a file speaks of: its header's when it has a title, else its name (`Artist - Title.lrc`, `01 - Title.lrc`, `Title.lrc`). */
const namesOfFile = (name: string, tags: ParrotLyricsFileTags): { title: string; artist: string | null } | null => {
  if (tags.title?.trim()) return { title: tags.title, artist: tags.artist };
  const stem = (name.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "").trim();
  if (!stem) return null;
  const parts = stem.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const [first, ...rest] = parts;
    const title = rest.join(" - ");
    return /^\d{1,3}$/.test(first!.trim()) ? { title, artist: tags.artist } : { title, artist: first! };
  }
  return { title: stem.replace(/^\d{1,3}[.\s_]+/, "") || stem, artist: tags.artist };
};

/**
 * Matches a dropped file to a library song (PAR-LYR-09): by its header's artist, title, album and length, else by its
 * name, compared the way every other Parrot name is (case, accents and punctuation ignored). Never guesses: when the
 * names fit several songs that the artist, album and length do not tell apart, or fit none, the user picks.
 */
export const matchParrotLyricsFile = (file: { name: string; tags: ParrotLyricsFileTags }, songs: readonly ParrotLyricsSong[]): ParrotLyricsMatch => {
  const names = namesOfFile(file.name, file.tags);
  if (!names) return { kind: "unmatched" };
  const title = parrotComparableName(names.title);
  let found = songs.filter((song) => parrotComparableName(song.title) === title);
  if (found.length === 0) return { kind: "unmatched" };
  const narrow = (keep: (song: ParrotLyricsSong) => boolean) => {
    const kept = found.filter(keep);
    if (kept.length > 0) found = kept;
  };
  if (names.artist?.trim()) {
    const artist = parrotComparableName(names.artist);
    const byArtist = found.filter((song) => song.artist !== null && parrotComparableName(song.artist) === artist);
    // A title that only fits songs by another artist is no match to apply, but a list to pick from.
    if (byArtist.length === 0) return { kind: "ambiguous", trackIds: found.map((song) => song.id) };
    found = byArtist;
  }
  if (found.length > 1 && file.tags.album?.trim()) {
    const album = parrotComparableName(file.tags.album);
    narrow((song) => song.album !== null && parrotComparableName(song.album) === album);
  }
  const lengthMs = file.tags.lengthMs;
  if (found.length > 1 && lengthMs !== null) narrow((song) => song.durationMs !== null && Math.abs(song.durationMs - lengthMs) <= LENGTH_TOLERANCE_MS);
  return found.length === 1 ? { kind: "matched", trackId: found[0]!.id } : { kind: "ambiguous", trackIds: found.map((song) => song.id) };
};

/** A song of the import a lyrics file can go on: `id` is its audio file's path. */
export type ParrotLyricsImportSong = ParrotLyricsSong & { file: string };

/** Where the review puts a lyrics file (PAR-LYR-09): a song of the same import or of the library; `sure: false` waits for the user. */
export type ParrotLyricsPlacement = { source: "import" | "library"; id: string; sure: boolean };

const dirOf = (file: string) => file.split(/[\\/]/).slice(0, -1).join("/");
const stemOf = (file: string) => (file.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");

/**
 * Places a lyrics file on a song (PAR-LYR-09, Chris 2026-11-27): first among the songs of the same import (the audio
 * file with the same name in the same folder, then a song of the same folder its header or name fits, then any song of
 * the import it fits), then among the library's, where a name that fits several songs is narrowed by the folders it
 * sits in (the album's, then the artist's). A title that only contains the song's (or is contained in it) is offered,
 * never sure. Null: no song found, the user picks one.
 */
export const placeParrotLyricsFile = (
  file: { path: string; tags: ParrotLyricsFileTags },
  importSongs: readonly ParrotLyricsImportSong[],
  librarySongs: readonly ParrotLyricsSong[]
): ParrotLyricsPlacement | null => {
  const dir = dirOf(file.path);
  const stem = parrotComparableName(stemOf(file.path));
  const twin = importSongs.find((song) => dirOf(song.file) === dir && parrotComparableName(stemOf(song.file)) === stem);
  if (twin) return { source: "import", id: twin.id, sure: true };
  const folders = file.path.split(/[\\/]/).slice(0, -1).reverse().map(parrotComparableName);
  const byFolder = <T extends ParrotLyricsSong>(songs: readonly T[], ids: readonly string[]): T[] => {
    const found = songs.filter((song) => ids.includes(song.id));
    const inAlbum = found.filter((song) => song.album !== null && parrotComparableName(song.album) === folders[0]);
    const atArtist = (inAlbum.length ? inAlbum : found).filter((song) => song.artist !== null && parrotComparableName(song.artist) === folders[1]);
    return atArtist.length ? atArtist : inAlbum.length ? inAlbum : found;
  };
  const fit = (source: ParrotLyricsPlacement["source"], songs: readonly ParrotLyricsSong[]): ParrotLyricsPlacement | null => {
    const match = matchParrotLyricsFile({ name: file.path, tags: file.tags }, songs);
    if (match.kind === "matched") return { source, id: match.trackId, sure: true };
    if (match.kind === "unmatched") return null;
    const narrowed = byFolder(songs, match.trackIds);
    return { source, id: narrowed[0]!.id, sure: narrowed.length === 1 && narrowed.length < match.trackIds.length };
  };
  const sameFolder = fit(
    "import",
    importSongs.filter((song) => dirOf(song.file) === dir)
  );
  if (sameFolder?.sure) return sameFolder;
  const placed = [sameFolder, fit("import", importSongs), fit("library", librarySongs)];
  const sure = placed.find((place) => place?.sure);
  if (sure) return sure;
  const offered = placed.find((place) => place !== null);
  if (offered) return offered;
  const title = parrotComparableName(file.tags.title?.trim() || stemOf(file.path).replace(/^\d{1,3}[.\s_-]+/, ""));
  if (title.length < 4) return null;
  const loose = (song: ParrotLyricsSong) => {
    const name = parrotComparableName(song.title);
    return name.length >= 4 && (title.includes(name) || name.includes(title));
  };
  const near = importSongs.find(loose);
  if (near) return { source: "import", id: near.id, sure: false };
  const far = librarySongs.find(loose);
  return far ? { source: "library", id: far.id, sure: false } : null;
};

/** The songs a lyrics file can be matched to in the library, with the names {@link matchParrotLyricsFile} compares. */
export const PARROT_LYRICS_SONGS_SQL = `SELECT t.id AS id, t.title AS title, ar.name AS artist, al.title AS album, t.duration_ms AS durationMs
  FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id`;

/** Words to keep as the user's own: synced lines (in time order) and their plain words, or plain words alone. */
export type ParrotOwnLyrics = { synced: readonly ParrotLyricLine[] | null; plain: string | null };

type OpContext = { now: number; newId: () => string };
const opMeta = (ctx: OpContext) => ({ id: ctx.newId(), createdAt: new Date(ctx.now).toISOString() });

const mmss = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * The lyrics row's text for the user's own words: synced as LRC headed by the song's `[ar:] [al:] [ti:] [length:]`
 * (Chris 2026-11-27: a file written from it matches its song again), plain as text; null when there are no words.
 */
export const parrotOwnLyricsText = (lyrics: ParrotOwnLyrics, song?: Omit<ParrotLyricsSong, "id">): { synced: string | null; plain: string | null } | null => {
  const lines = lyrics.synced && lyrics.synced.some((line) => line.text.trim()) ? lyrics.synced : null;
  const plain = lyrics.plain?.trim() ? lyrics.plain.trim() : lyrics.synced ? plainOf(lyrics.synced) || null : null;
  if (!lines && !plain) return null;
  const header = song
    ? [
        song.artist ? `[ar:${song.artist}]` : null,
        song.album ? `[al:${song.album}]` : null,
        song.title ? `[ti:${song.title}]` : null,
        song.durationMs ? `[length:${mmss(song.durationMs)}]` : null,
      ].filter((tag): tag is string => tag !== null)
    : [];
  return { synced: lines ? [...header, toLrc(lines)].join("\n") : null, plain };
};

/** The op keeping the user's own lyrics for a song (PAR-LYR-08), headed by the song's names when given; null when there are no words to keep. */
export const planParrotOwnLyrics = (trackId: string, lyrics: ParrotOwnLyrics, ctx: OpContext, song?: Omit<ParrotLyricsSong, "id">): ParrotLibraryOp | null => {
  const text = parrotOwnLyricsText(lyrics, song);
  if (!text) return null;
  return createParrotOp("lyrics.set", { trackId, ...text, source: PARROT_LYRICS_USER, fetchedAt: ctx.now }, opMeta(ctx));
};

/**
 * The op taking the user's own lyrics away (PAR-LYR-11): the row goes, so the song is "never looked up" again and the
 * automatic lookup and "Fetch lyrics" find its words as for any other song.
 */
export const planParrotRemoveOwnLyrics = (trackId: string, ctx: OpContext): ParrotLibraryOp => createParrotOp("lyrics.delete", { trackId }, opMeta(ctx));

/** Each song with the `source` of its lyrics row (null: no row), for {@link parrotLyricsOpsToKeep}. */
export const PARROT_LYRICS_KEEP_SQL = "SELECT t.id AS id, l.source AS source FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id";

/**
 * The lyrics ops still worth saving on the library as it is now: none for a song deleted meanwhile, and none from a
 * lookup over the user's own lyrics (PAR-LYR-08), even when the lookup started before the user saved them.
 */
export const parrotLyricsOpsToKeep = (ops: readonly ParrotLibraryOp[], songs: readonly { id: string; source: string | null }[]): ParrotLibraryOp[] => {
  const source = new Map(songs.map((song) => [song.id, song.source]));
  return ops.filter((op) => {
    if (op.type !== "lyrics.set" && op.type !== "lyrics.delete") return false;
    if (!source.has(op.payload.trackId)) return false;
    if (op.type === "lyrics.delete") return true;
    return op.payload.source === PARROT_LYRICS_USER || source.get(op.payload.trackId) !== PARROT_LYRICS_USER;
  });
};

/** One line in the lyrics editor's timing mode: its words and when it starts (null: not timed yet). */
export type ParrotEditorLine = { text: string; ms: number | null };

/**
 * The editor's lines from its text (PAR-LYR-10): one per line with words; pasted LRC keeps its times, so a user can
 * paste a file's contents instead of dropping it. Blank lines (verse breaks) are not lines to time.
 */
export const parrotEditorLines = (text: string): ParrotEditorLine[] =>
  text
    .split(/\r?\n/)
    .map((raw, index) => readLine(raw, index + 1))
    .filter((line) => !line.tag && line.text)
    .map((line) => ({ text: line.text, ms: line.bad || line.times.length === 0 ? null : Math.min(...line.times) }));

/** The editor's text for a song's current lyrics: timed lines as LRC when synced, else the plain words. */
export const parrotEditorText = (lyrics: ParrotLyrics | null): string =>
  lyrics?.synced ? toLrc(lyrics.synced.filter((line) => line.text)) : (lyrics?.plain ?? "");

/** The text back from timing mode: timed lines keep their time tag, untimed ones are words alone. */
export const parrotEditorLinesText = (lines: readonly ParrotEditorLine[]): string =>
  lines.map((line) => (line.ms === null ? line.text : toLrc([{ ms: line.ms, text: line.text }]))).join("\n");

/** Times line `index` at `ms` (the tap as the line starts). */
export const tapParrotEditorLine = (lines: readonly ParrotEditorLine[], index: number, ms: number): ParrotEditorLine[] =>
  lines.map((line, at) => (at === index ? { ...line, ms: Math.max(0, Math.round(ms)) } : line));

/** Moves a timed line by `deltaMs` (the ± nudge), never before the song's start; an untimed line stays untimed. */
export const nudgeParrotEditorLine = (lines: readonly ParrotEditorLine[], index: number, deltaMs: number): ParrotEditorLine[] =>
  lines.map((line, at) => (at === index && line.ms !== null ? { ...line, ms: Math.max(0, line.ms + deltaMs) } : line));

/** Takes every time away (start timing over). */
export const clearParrotEditorTimes = (lines: readonly ParrotEditorLine[]): ParrotEditorLine[] => lines.map((line) => ({ ...line, ms: null }));

/**
 * What the editor saves (PAR-LYR-10): synced lyrics when every line is timed, else the plain words of `text`. Times
 * that go back are never sorted: the save is refused with the lines (1-based among the lines with words) to fix.
 */
export const saveParrotEditorLyrics = (text: string): { ok: true; lyrics: ParrotOwnLyrics } | { ok: false; problem: ParrotLyricsProblem } => {
  if (UTF8.encode(text).length > PARROT_LYRICS_FILE_MAX_BYTES) return { ok: false, problem: { kind: "tooBig" } };
  const lines = parrotEditorLines(text);
  if (lines.length === 0) return { ok: false, problem: { kind: "empty" } };
  if (lines.every((line) => line.ms !== null)) {
    for (let index = 1; index < lines.length; index++)
      if (lines[index]!.ms! < lines[index - 1]!.ms!) return { ok: false, problem: { kind: "outOfOrder", line: index + 1 } };
    const synced = lines.map((line) => ({ ms: line.ms!, text: line.text }));
    return { ok: true, lyrics: { synced, plain: plainOf(synced) } };
  }
  const plain = text
    .split(/\r?\n/)
    .map((raw, index) => readLine(raw, index + 1))
    .filter((line) => !line.tag)
    .map((line) => line.text)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ok: true, lyrics: { synced: null, plain } };
};
