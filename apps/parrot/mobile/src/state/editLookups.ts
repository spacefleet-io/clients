// What the phone's edit dialog looks up on its own (PAR-META-18, PAR-LYR-05, PAR-META-20), as the desktop's does
// (`editLookups.ts` there) and the way Badger's import window looks up intro and credits markers: the lyrics are read as
// the dialog opens and asked for when a song never was, with a shimmer while the answer is on its way; the fields that
// name something (title, artist, album) suggest songs, albums and artists as the user types, ranked against all the
// fields together (@space/parrot-core `editSuggest`): the library's own at once, our music library's once asked
// ("Still asking…" meanwhile). Nothing is saved until Save.
import { useEffect, useRef, useState } from "react";
import {
  mergeParrotEditSuggestions,
  parrotEditAlbumLyricsState,
  parrotEditAlbumLyricsToAsk,
  parrotEditLyricsState,
  parrotLibrarySuggestions,
  parrotLookupSuggestions,
  parrotLyricsOrSearching,
  parrotMusicSuggestQuery,
  type ParrotEditAlbumLyricsState,
  type ParrotEditCover,
  type ParrotEditLyricsState,
  type ParrotEditOriginal,
  type ParrotEditSuggestion,
  type ParrotEditSuggestions,
  type ParrotEditSuggestQuery,
  type ParrotLyrics,
  type ParrotSuggestLibrary,
} from "@space/parrot-core";
import { fetchSuggestionCover, fetchTrackLyrics, listAlbumTracks, lyricsPending, readSuggestLibrary, readTrackLyrics } from "../lib/library";
import { lookupClient } from "../lib/lookup";

type LyricsAsk = { status: "idle" | "busy" } | { status: "failed"; reason: string };
/** Our music library's answer for what is typed: on its way, in, or failed (the list still shows the library's own). */
export type EditSuggestLookup = { status: "busy" } | { status: "done" } | { status: "failed"; reason: string };

export type EditLookups = {
  suggest: {
    /** The list under the field being typed in; null when there is none. `field` is the dialog's field. */
    list: { field: ParrotEditSuggestQuery["field"]; text: string; suggestions: ParrotEditSuggestions; lookup: EditSuggestLookup } | null;
    /** Asks for what `query` fits (null or nothing typed: closes the list). */
    ask: (query: ParrotEditSuggestQuery | null) => void;
    /** The cover of an album pick, for review in the album dialog; null when it has none. */
    cover: (pick: ParrotEditSuggestion) => Promise<ParrotEditCover | null>;
  };
  lyrics: { kind: "track"; state: ParrotEditLyricsState; searchAgain: () => void } | { kind: "album"; state: ParrotEditAlbumLyricsState; searchMissing: () => void };
};

/** Typing pauses this long before our music library is asked: one question per pause, never one per letter. */
export const SUGGEST_ASK_DELAY_MS = 300;

type Suggesting = { key: string; seq: number; query: ParrotEditSuggestQuery; library: ParrotEditSuggestion[]; lookup: ParrotEditSuggestion[]; status: EditSuggestLookup };
type Asking = { seq: number; timer: ReturnType<typeof setTimeout> | undefined; busy: boolean; next: { seq: number; key: string; query: ParrotEditSuggestQuery } | null };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The dialog's autocomplete and Lyrics section for `item` (null: the dialog is closed). `libraryVersion` bumps when the
 * library changed (e.g. the automatic pass kept a song's words), so the section and the suggestions are read again.
 */
export function useEditLookups({
  item,
  original,
  libraryVersion,
}: {
  item: { kind: "track" | "album"; id: string } | null;
  /** The item's fields as the dialog opened: a suggestion that would change none of them is left out. */
  original: ParrotEditOriginal | null;
  libraryVersion: number;
}): EditLookups | null {
  const key = item ? `${item.kind}:${item.id}` : null;
  const [read, setRead] = useState<{ key: string; songs: ReadonlyMap<string, ParrotLyrics | null> } | null>(null);
  const [ask, setAsk] = useState<{ key: string; state: LyricsAsk } | null>(null);
  // The automatic pass took or let go of a song: read again, so "Looking for lyrics…" ends with its answer.
  const [pendingChanges, setPendingChanges] = useState(0);
  useEffect(() => lyricsPending.onChange(() => setPendingChanges((count) => count + 1)), []);
  const [suggesting, setSuggesting] = useState<Suggesting | null>(null);
  const asking = useRef<Asking>({ seq: 0, timer: undefined, busy: false, next: null });
  const suggestLibrary = useRef<{ key: string; read: Promise<ParrotSuggestLibrary | null> } | null>(null);

  const readLyrics = async (forKey: string, target: { kind: "track" | "album"; id: string }) => {
    const ids = target.kind === "track" ? [target.id] : (await listAlbumTracks(target.id)).map((track) => track.id);
    const answers = await Promise.all(ids.map(async (id) => [id, parrotLyricsOrSearching(await readTrackLyrics(id), lyricsPending.has(id))] as const));
    setRead((current) => (current && current.key !== forKey ? current : { key: forKey, songs: new Map(answers) }));
    return answers;
  };
  const searchLyrics = async (forKey: string, target: { kind: "track" | "album"; id: string }, songs: readonly string[]) => {
    if (songs.length === 0) return;
    setAsk({ key: forKey, state: { status: "busy" } });
    console.info(`[parrot] edit dialog looks for lyrics of ${songs.length} song(s) of ${forKey}`);
    let failed: string | null = null;
    // One at a time, as the automatic pass asks: the lookup service is never flooded by one album.
    for (const id of songs) {
      try {
        const answer = await fetchTrackLyrics(id, async (question) => (await lookupClient()).musicLyrics(question));
        console.info(`[parrot] edit dialog lyrics for ${id}: ${answer.outcome}`);
      } catch (error) {
        failed ??= errorText(error);
        console.warn(`[parrot] edit dialog lyrics lookup failed for ${id}: ${errorText(error)}`);
      }
    }
    setAsk({ key: forKey, state: failed === null ? { status: "idle" } : { status: "failed", reason: failed } });
    await readLyrics(forKey, target);
  };

  useEffect(() => {
    if (!key || !item) return;
    let cancelled = false;
    readLyrics(key, item).then(
      (answers) => {
        if (cancelled) return;
        const never = parrotEditAlbumLyricsToAsk(answers.map(([id, lyrics]) => ({ id, lyrics })));
        if (never.length > 0 && ask?.key !== key) {
          console.info(`[parrot] edit dialog asks lyrics for ${never.length} never-looked-up song(s) of ${key}`);
          void searchLyrics(key, item, never);
        }
      },
      (error: unknown) => console.warn(`[parrot] edit dialog could not read lyrics of ${key}: ${errorText(error)}`)
    );
    return () => {
      cancelled = true;
    };
    // Read again when the dialog opens on something else, the library changed, or the automatic pass moved on.
  }, [key, libraryVersion, pendingChanges]);

  // Another item (or none): the last one's list and its pending question go.
  useEffect(() => {
    const now = asking.current;
    return () => {
      clearTimeout(now.timer);
      now.seq += 1;
      now.next = null;
      setSuggesting(null);
    };
  }, [key]);

  /** The library to rank against, read once per opened item and library version. */
  const libraryFor = (forKey: string) => {
    const readKey = `${forKey}@${libraryVersion}`;
    if (suggestLibrary.current?.key !== readKey) {
      suggestLibrary.current = {
        key: readKey,
        read: readSuggestLibrary().catch((error: unknown) => {
          console.warn(`[parrot] edit dialog could not read the library for suggestions: ${errorText(error)}`);
          return null;
        }),
      };
    }
    return suggestLibrary.current.read;
  };

  // One question at a time to our music library: a newer one waits for the one on its way, and only the latest is sent.
  const askLookup = async (seq: number, forKey: string, query: ParrotEditSuggestQuery) => {
    const state = asking.current;
    if (state.busy) {
      state.next = { seq, key: forKey, query };
      return;
    }
    state.busy = true;
    let outcome: { results: ParrotEditSuggestion[] } | { failed: string };
    try {
      const { results } = await (await lookupClient()).musicSuggest(parrotMusicSuggestQuery(query));
      outcome = { results: parrotLookupSuggestions(results, query) };
      console.info(`[parrot] edit dialog suggest ${forKey} ${query.field}: ${results.length} from the lookup`);
    } catch (error) {
      outcome = { failed: errorText(error) };
      console.warn(`[parrot] edit dialog suggest lookup failed for ${forKey} ${query.field}: ${outcome.failed}`);
    } finally {
      state.busy = false;
    }
    setSuggesting((current) =>
      current && current.seq === seq
        ? "failed" in outcome
          ? { ...current, status: { status: "failed", reason: outcome.failed } }
          : { ...current, lookup: outcome.results, status: { status: "done" } }
        : current
    );
    const next = state.next;
    state.next = null;
    if (next && next.seq === state.seq) void askLookup(next.seq, next.key, next.query);
  };

  if (!item || !key) return null;

  const askSuggestions = (query: ParrotEditSuggestQuery | null) => {
    const state = asking.current;
    state.seq += 1;
    const seq = state.seq;
    clearTimeout(state.timer);
    state.next = null;
    if (!query || query.text.trim() === "") return setSuggesting(null);
    setSuggesting({ key, seq, query, library: [], lookup: [], status: { status: "busy" } });
    void libraryFor(key).then((library) => {
      if (!library || asking.current.seq !== seq) return;
      const found = parrotLibrarySuggestions(library, query);
      setSuggesting((current) => (current && current.seq === seq ? { ...current, library: found } : current));
    });
    state.timer = setTimeout(() => void askLookup(seq, key, query), SUGGEST_ASK_DELAY_MS);
  };

  const shown = suggesting?.key === key ? suggesting : null;
  const suggest: EditLookups["suggest"] = {
    list: shown
      ? { field: shown.query.field, text: shown.query.text, suggestions: mergeParrotEditSuggestions(shown.library, shown.lookup, original ?? undefined), lookup: shown.status }
      : null,
    ask: askSuggestions,
    cover: async (pick) => (pick.coverId ? fetchSuggestionCover(pick.coverId, await lookupClient()) : null),
  };

  const songs = read?.key === key ? read.songs : null;
  const asked = ask?.key === key ? ask.state : { status: "idle" as const };
  const lyrics: EditLookups["lyrics"] =
    item.kind === "track"
      ? {
          kind: "track",
          state: parrotEditLyricsState(songs ? (songs.get(item.id) ?? null) : undefined, asked),
          searchAgain: () => void searchLyrics(key, item, [item.id]),
        }
      : {
          kind: "album",
          state: songs ? parrotEditAlbumLyricsState([...songs.values()], asked.status === "busy") : { status: "loading" },
          searchMissing: () =>
            void searchLyrics(
              key,
              item,
              [...(songs ?? new Map<string, ParrotLyrics | null>())].filter(([, found]) => parrotEditLyricsState(found).status !== "found").map(([id]) => id)
            ),
        };
  return { suggest, lyrics };
}
