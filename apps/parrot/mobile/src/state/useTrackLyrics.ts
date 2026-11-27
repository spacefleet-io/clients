// The lyrics of one song and what to say about them (PAR-LYR-01/04/05/06), for every screen that shows them: the phone's
// Lyrics sheet (PlayerLyrics) and the TV's Now playing and full-screen lyrics (PAR-TV-07, PAR-TV-08). Only the drawing
// differs between them; the reading, the automatic pass and "Search again" are this one hook.
//
// While a lookup for the song is queued or running (the automatic pass, or "Search again"), it says "Looking for
// lyrics…", never "No lyrics" (PAR-LYR-06). A song never looked up is handed to the automatic pass as soon as a screen
// shows it (PAR-LYR-05), which asks it next; the screen never asks the metadata service on its own (PAR-COPY-01), only
// on "Search again". "Search again" shows only once a lookup came back empty or failed, never while one is on its way
// (Chris 2026-11-16).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ParrotLyrics } from "@space/parrot-core";
import { fetchTrackLyrics, lyricsPending, readTrackLyrics } from "../lib/library";
import { lookupClient } from "../lib/lookup";
import { useSession } from "./session";

type FetchState = "idle" | "busy" | "none" | "failed";
/** One moment the automatic pass let go of a song (its identity tells reads begun before it from those after). */
type Settled = { trackId: string };

/** What a lyrics screen shows for the song. */
export type TrackLyricsView =
  /** The library is being read. */
  | { kind: "reading" }
  | { kind: "synced"; lines: NonNullable<ParrotLyrics["synced"]>; fetched: boolean }
  | { kind: "plain"; text: string; fetched: boolean }
  /** "Looking for lyrics…" (PAR-LYR-06). */
  | { kind: "searching" }
  /**
   * No lyrics: `found` names the final "No lyrics" (every source asked, PAR-LYR-04) rather than "No lyrics yet";
   * `body` the line under it; `searchAgain` whether "Search again" shows (PAR-LYR-05).
   */
  | { kind: "none"; found: boolean; body: "notFound" | "none" | "failed" | "fetch"; searchAgain: boolean };

const log = (event: string, payload: Record<string, unknown>) => console.log(`parrot.lyrics ${event} ${JSON.stringify(payload)}`);

export const useTrackLyrics = (trackId: string): { view: TrackLyricsView; searchAgain: () => void } => {
  // A new library version (e.g. the automatic lookup found this song's words, PAR-LYR-01) is read again.
  const { library, wantLyrics } = useSession();
  const libraryVersion = library.version;
  // Lyrics and the fetch state belong to one song: another song starts from its own.
  // `after`: the end of a lookup this read started after (null: none yet), so a read begun before it is known stale.
  // `readFailed`: the library could not be read, so a missing row does not mean "never looked up".
  const [lyrics, setLyrics] = useState<{ trackId: string; lyrics: ParrotLyrics | null; after: Settled | null; readFailed?: boolean } | null>(null);
  // The songs this screen already handed to the automatic pass on its own: each is handed once.
  const askedOnOpen = useRef(new Set<string>());
  const [fetchState, setFetchState] = useState<{ trackId: string; state: FetchState } | null>(null);
  // PAR-LYR-06: the automatic pass still has this song queued or running.
  const autoPending = useSyncExternalStore(lyricsPending.onChange, () => lyricsPending.has(trackId));
  // When the pass lets go of the song, its answer is in the library but the words on screen are from a read begun
  // before: the screen keeps "Looking for lyrics…" until a read begun after that moment returns, so "No lyrics yet" and
  // its Fetch button never flash between the save and the re-read (derived during render, so no frame shows them).
  const [seen, setSeen] = useState<{ trackId: string; pending: boolean }>({ trackId, pending: autoPending });
  const [settled, setSettled] = useState<Settled | null>(null);
  if (seen.trackId !== trackId || seen.pending !== autoPending) {
    if (seen.trackId === trackId && seen.pending && !autoPending) setSettled({ trackId });
    setSeen({ trackId, pending: autoPending });
  }
  const after = settled?.trackId === trackId ? settled : null;

  useEffect(() => {
    let live = true;
    readTrackLyrics(trackId).then(
      (found) => {
        log("read", { trackId, synced: found?.synced?.length ?? 0, plain: Boolean(found?.plain), fetched: found?.fetched ?? false });
        if (live) setLyrics({ trackId, lyrics: found, after });
      },
      (error: unknown) => {
        log("read_failed", { trackId, message: error instanceof Error ? error.message : String(error) });
        if (live) setLyrics({ trackId, lyrics: null, after, readFailed: true });
      }
    );
    return () => {
      live = false;
    };
  }, [trackId, libraryVersion, after]);

  const current = lyrics?.trackId === trackId ? lyrics.lyrics : null;
  const staleRead = after !== null && lyrics?.after !== after;
  // Read, and no lyrics row at all: never looked up (PAR-LYR-05), handed to the automatic pass below.
  const neverLookedUp = lyrics?.trackId === trackId && lyrics.lyrics === null && !lyrics.readFailed;
  // The pass let go of a song this screen handed it, still never looked up: its lookup failed or the pass stopped.
  const handedAndLetGo = neverLookedUp && !autoPending && !staleRead && askedOnOpen.current.has(trackId);
  const ownState: FetchState = fetchState?.trackId === trackId ? fetchState.state : "idle";
  const state: FetchState = ownState === "idle" && handedAndLetGo ? "failed" : ownState;

  const searchAgain = () => {
    setFetchState({ trackId, state: "busy" });
    log("fetch", { trackId });
    fetchTrackLyrics(trackId, async (question) => (await lookupClient()).musicLyrics(question)).then(
      (result) => {
        log("fetched", { trackId, outcome: result.outcome });
        setFetchState({ trackId, state: result.outcome === "none" ? "none" : "idle" });
        if (result.lyrics) setLyrics({ trackId, lyrics: result.lyrics, after });
      },
      (error: unknown) => {
        log("fetch_failed", { trackId, message: error instanceof Error ? error.message : String(error) });
        setFetchState({ trackId, state: "failed" });
      }
    );
  };

  useEffect(() => {
    // A read begun before the pass let go of the song is not proof it was never looked up: wait for the re-read.
    if (!neverLookedUp || autoPending || staleRead || state !== "idle" || askedOnOpen.current.has(trackId)) return;
    askedOnOpen.current.add(trackId);
    log("want", { trackId });
    wantLyrics(trackId);
  }, [neverLookedUp, autoPending, staleRead, state, trackId, wantLyrics]);

  return { view: lyricsView({ read: lyrics?.trackId === trackId, current, state, autoPending, staleRead, neverLookedUp }), searchAgain };
};

/** What shows, from where the reading and the lookups stand (pure, for the tests). */
export const lyricsView = (input: {
  read: boolean;
  current: ParrotLyrics | null;
  state: FetchState;
  autoPending: boolean;
  staleRead: boolean;
  neverLookedUp: boolean;
}): TrackLyricsView => {
  const { read, current, state, autoPending, staleRead, neverLookedUp } = input;
  if (!read) return { kind: "reading" };
  if (current?.synced) return { kind: "synced", lines: current.synced, fetched: current.fetched };
  if (current?.plain) return { kind: "plain", text: current.plain, fetched: current.fetched };
  if (state === "busy" || autoPending || staleRead || (neverLookedUp && state === "idle")) return { kind: "searching" };
  // A song every source was asked about: the final "No lyrics" (PAR-LYR-04). "Search again" (PAR-LYR-05) only after a
  // lookup came back empty or failed.
  const notFound = current?.notFound === true && state === "idle";
  return {
    kind: "none",
    found: notFound || state === "none",
    body: notFound ? "notFound" : state === "none" ? "none" : state === "failed" ? "failed" : "fetch",
    searchAgain: notFound || state === "none" || state === "failed",
  };
};

/** The i18n keys of a "none" view's title and line. */
export const lyricsNoneText = (view: Extract<TrackLyricsView, { kind: "none" }>): { title: string; body: string } => ({
  title: view.found ? "shell.nowPlaying.noLyricsFoundTitle" : "shell.nowPlaying.noLyricsTitle",
  body:
    view.body === "notFound"
      ? "shell.nowPlaying.noLyricsFoundBody"
      : view.body === "none"
        ? "shell.nowPlaying.fetchLyricsNone"
        : view.body === "failed"
          ? "shell.nowPlaying.fetchLyricsFailed"
          : "shell.nowPlaying.fetchLyricsBody",
});

/** The i18n key of the line naming where the lyrics came from. */
export const lyricsSourceKey = (view: Extract<TrackLyricsView, { kind: "synced" | "plain" }>): string =>
  view.kind === "synced"
    ? view.fetched
      ? "shell.nowPlaying.fetchedSyncedLyricsSource"
      : "shell.nowPlaying.syncedLyricsSource"
    : view.fetched
      ? "shell.nowPlaying.fetchedPlainLyricsSource"
      : "shell.nowPlaying.plainLyricsSource";
