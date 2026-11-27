/**
 * The lyrics files of a drop in the import review (PAR-LYR-09, Chris 2026-11-27). Every drop opens the review: a
 * `.lrc`/`.txt` file is placed on a song of the same import first, then on one of the library (by its header, its
 * name, then its folders), and the user can always change or remove where it goes. A placement the review is not sure
 * of is never applied until the user picks the song. With songs in the drop, each song shows its lyrics file on a line
 * of its own under it and the files placed nowhere wait at the end of the list; a drop of lyrics files alone lists one
 * row per file.
 */
import { useMemo, useState } from "react";
import { FileText, X } from "lucide-react";
import { Button, ImportReviewBadge, ImportReviewSection, Input } from "@space/ui";
import { parrotLyricsProblemText } from "@space/ui/parrot/own-lyrics";
import {
  parrotComparableName,
  parseParrotLyricsFile,
  placeParrotLyricsFile,
  type ParrotLyricsImportSong,
  type ParrotLyricsPlacement,
  type ParrotLyricsProblem,
} from "@space/parrot-core";
import type { ParrotLibraryTrack } from "@space/parrot-ingest";
import type { ParrotImportLyricsChoice, ParrotImportScan, ParrotScanEntry } from "../../shared/ipc";
import { problemLabels } from "./ownLyrics";
import type { Translate } from "./i18n";

/** A song a lyrics file goes on: one of the import's, by its audio file, or one of the library's. */
type LyricsSong = ParrotImportLyricsChoice["song"];
/** A song the user can put a lyrics file on, with the names the review shows for it. */
type SongOption = { song: LyricsSong; key: string; title: string; artist: string; album: string; here: boolean; search: string };
/** One lyrics file of the scan: why it cannot be kept (null: it can), and where the review would put it. */
type LyricsItem = { file: string; name: string; problem: ParrotLyricsProblem | "unreadable" | null; guess: ParrotLyricsPlacement | null };
/** Where a lyrics file is: on a song (`how`: the review was sure, or the user chose), or nowhere yet. */
type LyricsState = { item: LyricsItem; song: LyricsSong | null; how: "matched" | "chosen" | null };

const songKey = (song: LyricsSong) => ("file" in song ? `file:${song.file}` : `track:${song.trackId}`);
const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;

/**
 * The review's lyrics files and where each goes. `entries` are the import's songs with the names the review shows;
 * `tracks` the library's songs. A song takes one file: a second file the review would put on it waits to be placed.
 */
export function useImportLyrics(scan: ParrotImportScan, entries: ReadonlyMap<string, ParrotScanEntry>, tracks: readonly ParrotLibraryTrack[]) {
  const items = useMemo<LyricsItem[]>(() => {
    const importSongs: ParrotLyricsImportSong[] = scan.entries.map((entry) => ({
      id: entry.file,
      file: entry.file,
      title: entry.title,
      artist: entry.artist,
      album: entry.album,
      durationMs: entry.durationMs,
    }));
    const librarySongs = tracks.map((track) => ({ id: track.id, title: track.title, artist: track.artistName, album: track.albumTitle, durationMs: track.durationMs }));
    const read = scan.lyrics.map((found): LyricsItem => {
      const name = fileName(found.file);
      if (found.text === undefined) return { file: found.file, name, problem: found.error === "tooBig" ? { kind: "tooBig" } : "unreadable", guess: null };
      const lyrics = parseParrotLyricsFile(found.text, name);
      const problem = lyrics.problems[0] ?? null;
      return { file: found.file, name, problem, guess: problem ? null : placeParrotLyricsFile({ path: found.file, tags: lyrics.tags }, importSongs, librarySongs) };
    });
    const placed = read.filter((item) => item.guess?.sure).length;
    console.info(`[import-review] ${read.length} lyrics file(s): ${placed} placed, ${read.filter((item) => item.problem).length} not readable as lyrics`);
    return read;
  }, [scan, tracks]);

  const options = useMemo<SongOption[]>(() => {
    const option = (song: LyricsSong, title: string, artist: string, album: string, here: boolean): SongOption => ({
      song,
      key: songKey(song),
      title,
      artist,
      album,
      here,
      search: parrotComparableName(`${title} ${artist} ${album}`),
    });
    return [
      ...[...entries.values()].map((entry) => option({ file: entry.file }, entry.title, entry.artist, entry.album, true)),
      ...tracks.map((track) => option({ trackId: track.id }, track.title, track.artistName, track.albumTitle, false)),
    ];
  }, [entries, tracks]);
  const optionOf = useMemo(() => new Map(options.map((option) => [option.key, option])), [options]);

  /** What the user chose for a file (null: removed from its song); a file not in here goes where the review put it. */
  const [picked, setPicked] = useState<Record<string, LyricsSong | null>>({});

  const states = useMemo<LyricsState[]>(() => {
    const taken = new Set<string>();
    return items.map((item): LyricsState => {
      const chosen = picked[item.file];
      const song = chosen !== undefined ? chosen : item.guess?.sure ? (item.guess.source === "import" ? { file: item.guess.id } : { trackId: item.guess.id }) : null;
      if (!song || item.problem || taken.has(songKey(song))) return { item, song: null, how: null };
      taken.add(songKey(song));
      return { item, song, how: chosen !== undefined ? "chosen" : "matched" };
    });
  }, [items, picked]);
  const onSong = useMemo(() => new Map(states.flatMap((state) => (state.song ? [[songKey(state.song), state] as const] : []))), [states]);

  /** Puts a file on a song (null: on none); the file that was on that song waits to be placed. */
  const pick = (file: string, song: LyricsSong | null) => {
    const before = song ? onSong.get(songKey(song)) : undefined;
    console.info(`[import-review] lyrics ${fileName(file)} ${song ? `put on ${songKey(song)}` : "removed"}${before && before.item.file !== file ? `; ${before.item.name} waits to be placed` : ""}`);
    setPicked((previous) => ({ ...previous, ...(before && before.item.file !== file ? { [before.item.file]: null } : {}), [file]: song }));
  };

  /** The files on a song, as confirmImport takes them; an import song's file only while the song is ticked. */
  const choices = (ticked: ReadonlySet<string>): ParrotImportLyricsChoice[] =>
    states.flatMap((state) => (state.song && (!("file" in state.song) || ticked.has(state.song.file)) ? [{ lyricsFile: state.item.file, song: state.song }] : []));

  return { states, options, optionOf, onSong, pick, choices };
}

export type ImportLyrics = {
  states: LyricsState[];
  options: SongOption[];
  optionOf: ReadonlyMap<string, SongOption>;
  onSong: ReadonlyMap<string, LyricsState>;
  pick: (file: string, song: LyricsSong | null) => void;
  choices: (ticked: ReadonlySet<string>) => ParrotImportLyricsChoice[];
};

const RESULTS = 8;

/** The search a lyrics file's "Change" opens: the import's songs first, then the library's, by name. */
function SongSearch({ t, lyrics, file, onClose }: { t: Translate; lyrics: ImportLyrics; file: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const words = parrotComparableName(query).split(" ").filter(Boolean);
  const found = words.length === 0 ? [] : lyrics.options.filter((option) => words.every((word) => option.search.includes(word))).slice(0, RESULTS);
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-border/60 bg-background/60 p-2" data-testid="import-lyrics-search">
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("import.lyrics.search")}
          aria-label={t("import.lyrics.search")}
          className="h-8 text-sm"
          data-testid="import-lyrics-search-input"
        />
        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={t("import.lyrics.close")} onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {words.length > 0 && found.length === 0 ? <div className="px-1 text-xs text-muted-foreground">{t("import.lyrics.noResult")}</div> : null}
      {found.map((option) => (
        <button
          key={option.key}
          type="button"
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
          onClick={() => {
            lyrics.pick(file, option.song);
            onClose();
          }}
          data-testid="import-lyrics-result"
          data-song={option.key}
        >
          <span className="min-w-0 flex-1 truncate">
            {option.title}
            <span className="text-muted-foreground"> · {[option.artist, option.album].filter(Boolean).join(" · ")}</span>
          </span>
          {option.here ? <ImportReviewBadge>{t("import.lyrics.here")}</ImportReviewBadge> : null}
        </button>
      ))}
    </div>
  );
}

const problemText = (t: Translate, problem: ParrotLyricsProblem | "unreadable") =>
  problem === "unreadable" ? t("import.lyrics.unreadable") : parrotLyricsProblemText(problem, problemLabels(t));

/** The line under an import song that has a lyrics file: "Lyrics: Song.lrc · Change · Remove". */
export function ImportLyricsLine({ t, lyrics, songFile }: { t: Translate; lyrics: ImportLyrics; songFile: string }) {
  const [searching, setSearching] = useState(false);
  const state = lyrics.onSong.get(songKey({ file: songFile }));
  if (!state) return null;
  return (
    <div className="border-b border-border/30 bg-muted/10 py-1.5 pl-[4.75rem] pr-3 text-xs text-muted-foreground" data-testid="import-song-lyrics" data-file={songFile} data-lyrics={state.item.name}>
      <div className="flex min-w-0 items-center gap-1.5">
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate" title={state.item.file}>
          {t("import.lyrics.line", { file: state.item.name })}
        </span>
        <span aria-hidden>·</span>
        <button type="button" className="shrink-0 font-medium text-foreground hover:underline" onClick={() => setSearching((open) => !open)} data-testid="import-song-lyrics-change">
          {t("import.lyrics.change")}
        </button>
        <span aria-hidden>·</span>
        <button type="button" className="shrink-0 font-medium text-foreground hover:underline" onClick={() => lyrics.pick(state.item.file, null)} data-testid="import-song-lyrics-remove">
          {t("import.lyrics.remove")}
        </button>
      </div>
      {searching ? <SongSearch t={t} lyrics={lyrics} file={state.item.file} onClose={() => setSearching(false)} /> : null}
    </div>
  );
}

/** One lyrics file's row: its name, the song it goes on (artist · album · song), how sure that is, and "Change". */
function LyricsRow({ t, lyrics, state }: { t: Translate; lyrics: ImportLyrics; state: LyricsState }) {
  const [searching, setSearching] = useState(false);
  const { item } = state;
  const guess = !state.song && item.guess && !item.problem ? lyrics.optionOf.get(songKey(item.guess.source === "import" ? { file: item.guess.id } : { trackId: item.guess.id })) : undefined;
  const shown = state.song ? lyrics.optionOf.get(songKey(state.song)) : guess;
  const tone = state.song ? undefined : "attention";
  const badge = item.problem ? null : state.how === "matched" ? t("import.lyrics.matched") : state.how === "chosen" ? t("import.lyrics.chosen") : guess ? t("import.lyrics.unsure") : t("import.lyrics.none");
  return (
    <div className="border-b border-border/30 px-4 py-2.5 text-sm last:border-b-0" data-testid="import-lyrics-file" data-file={item.name} data-state={state.how ?? (item.problem ? "problem" : guess ? "unsure" : "none")}>
      <div className="flex min-w-0 items-center gap-2">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium" title={item.file}>
          {item.name}
        </span>
        {badge ? (
          <ImportReviewBadge tone={tone} data-testid="import-lyrics-confidence">
            {badge}
          </ImportReviewBadge>
        ) : null}
      </div>
      {item.problem ? (
        <div className="mt-1 pl-6 text-xs text-amber-300" data-testid="import-lyrics-problem">
          {problemText(t, item.problem)}
        </div>
      ) : (
        <div className="mt-1 flex min-w-0 items-center gap-2 pl-6 text-xs text-muted-foreground">
          <span className={`min-w-0 flex-1 truncate ${state.song ? "" : "italic"}`} data-testid="import-lyrics-song">
            {shown ? [shown.artist, shown.album, shown.title].filter(Boolean).join(" · ") : t("import.lyrics.choose")}
          </span>
          {guess ? (
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => lyrics.pick(item.file, guess.song)} data-testid="import-lyrics-use">
              {t("import.lyrics.use")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setSearching((open) => !open)} data-testid="import-lyrics-change">
            {t("import.lyrics.change")}
          </Button>
        </div>
      )}
      {searching ? <SongSearch t={t} lyrics={lyrics} file={item.file} onClose={() => setSearching(false)} /> : null}
    </div>
  );
}

/**
 * The lyrics files as a list: every file when the drop held lyrics files alone (`all`), else under "Lyrics files to
 * place" only the files on no song (the others show under their songs).
 */
export function ImportLyricsList({ t, lyrics, all }: { t: Translate; lyrics: ImportLyrics; all: boolean }) {
  const shown = all ? lyrics.states : lyrics.states.filter((state) => !state.song);
  if (shown.length === 0) return null;
  return (
    <div data-testid={all ? "import-lyrics-files" : "import-lyrics-to-place"}>
      <ImportReviewSection tone={all ? undefined : "attention"} className="pt-3">
        {t(all ? "import.lyrics.files" : "import.lyrics.toPlace")}
      </ImportReviewSection>
      {shown.map((state) => (
        <LyricsRow key={state.item.file} t={t} lyrics={lyrics} state={state} />
      ))}
    </div>
  );
}
