// What the phone's edit dialog looks up on its own (PAR-META-18, PAR-LYR-05, PAR-META-20), as the desktop's does
// (`editLookups.ts` there) and the way Badger's import window looks up intro and credits markers: the lyrics are read as
// the dialog opens and asked for when a song never was, with a shimmer while the answer is on its way; "Look it up
// again" asks our music library for a better match and fills the fields. Nothing is saved until Save.
import { useEffect, useState } from "react";
import {
  parrotEditAlbumLyricsState,
  parrotEditAlbumLyricsToAsk,
  parrotEditLyricsState,
  parrotLyricsOrSearching,
  type ParrotEditAlbumLyricsState,
  type ParrotEditLyricsState,
  type ParrotLyrics,
} from "@space/parrot-core";
import { fetchMetadata, fetchTrackLyrics, listAlbumTracks, lyricsPending, readTrackLyrics, type FetchedMetadata } from "../lib/library";
import { lookupClient } from "../lib/lookup";

export type EditLookUpFound = Extract<FetchedMetadata, { outcome: "found" }>;
export type EditLookUpState = "idle" | "busy" | "found" | "none" | "failed";
type LyricsAsk = { status: "idle" | "busy" } | { status: "failed"; reason: string };

export type EditLookups = {
  lookUp: { state: EditLookUpState; reason?: string; run: () => void };
  lyrics: { kind: "track"; state: ParrotEditLyricsState; searchAgain: () => void } | { kind: "album"; state: ParrotEditAlbumLyricsState; searchMissing: () => void };
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The dialog's "Look it up again" and Lyrics section for `item` (null: the dialog is closed). `libraryVersion` bumps
 * when the library changed (e.g. the automatic pass kept a song's words), so the section is read again.
 */
export function useEditLookups({
  item,
  libraryVersion,
  onFound,
}: {
  item: { kind: "track" | "album"; id: string } | null;
  libraryVersion: number;
  onFound: (found: EditLookUpFound) => void;
}): EditLookups | null {
  const key = item ? `${item.kind}:${item.id}` : null;
  const [lookUp, setLookUp] = useState<{ key: string; state: EditLookUpState; reason?: string } | null>(null);
  const [read, setRead] = useState<{ key: string; songs: ReadonlyMap<string, ParrotLyrics | null> } | null>(null);
  const [ask, setAsk] = useState<{ key: string; state: LyricsAsk } | null>(null);
  // The automatic pass took or let go of a song: read again, so "Looking for lyrics…" ends with its answer.
  const [pendingChanges, setPendingChanges] = useState(0);
  useEffect(() => lyricsPending.onChange(() => setPendingChanges((count) => count + 1)), []);

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

  if (!item || !key) return null;
  const songs = read?.key === key ? read.songs : null;
  const asking = ask?.key === key ? ask.state : { status: "idle" as const };
  const lyrics: EditLookups["lyrics"] =
    item.kind === "track"
      ? {
          kind: "track",
          state: parrotEditLyricsState(songs ? (songs.get(item.id) ?? null) : undefined, asking),
          searchAgain: () => void searchLyrics(key, item, [item.id]),
        }
      : {
          kind: "album",
          state: songs ? parrotEditAlbumLyricsState([...songs.values()], asking.status === "busy") : { status: "loading" },
          searchMissing: () =>
            void searchLyrics(
              key,
              item,
              [...(songs ?? new Map<string, ParrotLyrics | null>())].filter(([, found]) => parrotEditLyricsState(found).status !== "found").map(([id]) => id)
            ),
        };

  const lookUpState = lookUp?.key === key ? lookUp : { key, state: "idle" as const };
  const runLookUp = async () => {
    setLookUp({ key, state: "busy" });
    console.info(`[parrot] look it up again for ${key}`);
    try {
      const answer = await fetchMetadata(item, await lookupClient());
      console.info(`[parrot] look it up again for ${key}: ${answer.outcome}`);
      if (answer.outcome === "none") return setLookUp({ key, state: "none" });
      onFound(answer);
      setLookUp({ key, state: "found" });
    } catch (error) {
      console.warn(`[parrot] look it up again failed for ${key}: ${errorText(error)}`);
      setLookUp({ key, state: "failed", reason: errorText(error) });
    }
  };
  return { lookUp: { state: lookUpState.state, reason: lookUpState.reason, run: () => void runLookUp() }, lyrics };
}
