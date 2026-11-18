/**
 * What the edit dialog looks up on its own (PAR-META-18, PAR-LYR-05, PAR-META-20), the way Badger's import window looks
 * up intro and credits markers: the lyrics are read as the dialog opens and asked for when the song never was, with a
 * shimmer while the answer is on its way; "Look it up again" asks for a better match and fills the fields.
 */
import { useEffect, useState } from "react";
import {
  parrotEditAlbumLyricsState,
  parrotEditLyricsNeedsLookup,
  parrotEditLyricsState,
  type ParrotLyrics,
  type ParrotManageTarget,
} from "@space/parrot-core";
import type { ParrotEditLookUp, ParrotEditLookUpLabels, ParrotEditLyrics } from "@space/ui/parrot/manage";
import type { ParrotFetchMetadataResult } from "../../shared/ipc";
import type { Translate } from "./i18n";

export type ParrotEditLookUpFound = Extract<ParrotFetchMetadataResult, { outcome: "found" }>;
type EditTarget = ParrotManageTarget & { kind: "track" | "album" };
type LyricsAsk = { status: "idle" | "busy" } | { status: "failed"; reason: string };

export const editLookUpLabels = (t: Translate): ParrotEditLookUpLabels => ({
  lookUp: t("manage.lookUp"),
  lookUpHint: t("manage.lookUpHint"),
  lookUpFound: t("manage.lookUpFound"),
  searching: t("manage.searching"),
  lyrics: t("manage.lyrics"),
  lyricsSearching: t("nowPlaying.searchingLyricsTitle"),
  lyricsNone: t("nowPlaying.noLyricsFoundBody"),
  lyricsSearchAgain: t("manage.lyricsSearchAgain"),
  lyricsFailed: (reason) => t("manage.lyricsFailed", { reason }),
  albumLyrics: (found, count) => t("manage.albumLyrics", { found, count }),
  albumLyricsSearch: t("manage.albumLyricsSearch"),
});

/**
 * The dialog's "Look it up again" and Lyrics section for `target` (null: the dialog is closed). `songIds`: the songs of
 * an album target. `lyricsChanges` bumps when the main process kept or queued lyrics, so the section is read again.
 */
export function useEditLookups({
  target,
  title,
  songIds,
  lyricsChanges,
  t,
  onFound,
}: {
  target: EditTarget | null;
  title: string;
  songIds: readonly string[];
  lyricsChanges: number;
  t: Translate;
  onFound: (result: ParrotEditLookUpFound) => void;
}): { lookUp?: ParrotEditLookUp; lyrics?: ParrotEditLyrics } {
  const key = target ? `${target.kind}:${target.id}` : null;
  const [lookUp, setLookUp] = useState<{ key: string; state: ParrotEditLookUp["state"]; message?: string } | null>(null);
  const [read, setRead] = useState<{ key: string; songs: ReadonlyMap<string, ParrotLyrics | null> } | null>(null);
  const [ask, setAsk] = useState<{ key: string; state: LyricsAsk } | null>(null);
  const ids = target?.kind === "track" ? [target.id] : songIds;
  const idsKey = ids.join(",");

  const readLyrics = async (forKey: string, songs: readonly string[]) => {
    const answers = await Promise.all(songs.map(async (id) => [id, await window.parrot.getLyrics(id)] as const));
    setRead((current) => (current && current.key !== forKey ? current : { key: forKey, songs: new Map(answers) }));
    return answers;
  };
  const searchLyrics = async (forKey: string, songs: readonly string[]) => {
    if (songs.length === 0) return;
    setAsk({ key: forKey, state: { status: "busy" } });
    // The main process runs the lookups one after the other and holds the waiting ones as "Looking for lyrics…".
    const answers = await Promise.all(songs.map((id) => window.parrot.fetchLyrics(id).catch((error: unknown) => ({ ok: false as const, error: String(error) }))));
    const failed = answers.find((answer) => !answer.ok);
    if (failed && !failed.ok) console.warn(`[parrot] edit dialog lyrics lookup failed for ${forKey}: ${failed.error}`);
    setAsk({ key: forKey, state: failed && !failed.ok ? { status: "failed", reason: failed.error } : { status: "idle" } });
    await readLyrics(forKey, ids);
  };

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void readLyrics(key, ids).then((answers) => {
      if (cancelled) return;
      const never = answers.filter(([, lyrics]) => parrotEditLyricsNeedsLookup(lyrics)).map(([id]) => id);
      if (never.length > 0 && ask?.key !== key) {
        console.info(`[parrot] edit dialog asks lyrics for ${never.length} never-looked-up song(s) of ${key}`);
        void searchLyrics(key, never);
      }
    });
    return () => {
      cancelled = true;
    };
    // Read again when the dialog opens on something else, or the main process kept or queued lyrics.
  }, [key, idsKey, lyricsChanges]);

  if (!target || !key) return {};
  const songs = read?.key === key ? read.songs : null;
  const asking = ask?.key === key ? ask.state : { status: "idle" as const };
  const lyrics: ParrotEditLyrics =
    target.kind === "track"
      ? {
          kind: "track",
          state: parrotEditLyricsState(songs ? (songs.get(target.id) ?? null) : undefined, asking),
          onSearchAgain: () => void searchLyrics(key, [target.id]),
        }
      : {
          kind: "album",
          state: parrotEditAlbumLyricsState(songs ? ids.map((id) => songs.get(id)) : ids.map(() => undefined), asking.status === "busy"),
          onSearchMissing: () =>
            void searchLyrics(
              key,
              ids.filter((id) => parrotEditLyricsState(songs?.get(id) ?? null).status !== "found")
            ),
        };

  const lookUpState = lookUp?.key === key ? lookUp : { key, state: "idle" as const };
  const onLookUp = async () => {
    setLookUp({ key, state: "busy" });
    const result = await window.parrot.fetchMetadata(target).catch((error: unknown) => ({ ok: false as const, error: String(error) }));
    if (!result.ok) {
      console.warn(`[parrot] look it up again failed for ${key}: ${result.error}`);
      setLookUp({ key, state: "failed", message: t("manage.fetchFailed", { reason: result.error }) });
    } else if (result.outcome === "none") setLookUp({ key, state: "none", message: t("manage.fetchNone", { title }) });
    else {
      onFound(result);
      setLookUp({ key, state: "found" });
    }
  };
  return { lookUp: { state: lookUpState.state, message: lookUpState.message, onLookUp: () => void onLookUp() }, lyrics };
}
