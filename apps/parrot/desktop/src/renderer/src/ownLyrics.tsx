import { useState, type ReactElement } from "react";
import type { ParrotLyrics, ParrotOwnLyrics } from "@space/parrot-core";
import { toast } from "@space/ui";
import { ParrotLyricsEditorDialog, type ParrotLyricsEditorLabels } from "@space/ui/parrot/own-lyrics";
import type { ParrotLibraryTrack } from "@space/parrot-ingest";
import type { Translate } from "./i18n";
import type { PlayerClock } from "./playerClock";

/** The words for a lyrics text's problems, shared by the editor and the import review's lyrics files. */
export const problemLabels = (t: Translate): ParrotLyricsEditorLabels["problems"] => ({
  tooBig: t("lyricsProblem.tooBig"),
  empty: t("lyricsProblem.empty"),
  badTime: t("lyricsProblem.badTime"),
  untimedLine: t("lyricsProblem.untimedLine"),
  outOfOrder: t("lyricsProblem.outOfOrder"),
});

export type OwnLyricsActions = {
  openEditor: (trackId: string) => Promise<void>;
  remove: (trackId: string) => Promise<void>;
  dialogs: ReactElement;
  /** The editor is open: the player's clock is written at every tick so taps read the exact time. */
  editing: boolean;
};

/**
 * The user's own lyrics on the desktop (PAR-LYR-10, PAR-LYR-11): the editor, opened from a song's Lyrics tab or its ⋯
 * menu, and removing them. Dropped lyrics files go through the import review instead (PAR-LYR-09). Main saves.
 */
export function useOwnLyrics({
  t,
  tracks,
  playingId,
  playing,
  clock,
  onSeek,
  onToggle,
  onPlaySong,
}: {
  t: Translate;
  tracks: readonly ParrotLibraryTrack[];
  playingId: string | undefined;
  playing: boolean;
  clock: PlayerClock;
  onSeek: (ms: number) => void;
  onToggle: () => void;
  /** Plays the song from the start, so a song that is not playing can be timed. */
  onPlaySong: (trackId: string) => void;
}): OwnLyricsActions {
  const [editor, setEditor] = useState<{ trackId: string; title: string; lyrics: ParrotLyrics | null } | null>(null);
  const save = async (trackId: string, lyrics: ParrotOwnLyrics) => {
    const result = await window.parrot.setOwnLyrics(trackId, lyrics);
    if (!result.ok) throw new Error(result.error);
  };
  const openEditor = async (trackId: string) => {
    const track = tracks.find((row) => row.id === trackId);
    const lyrics = await window.parrot.getLyrics(trackId);
    setEditor({ trackId, title: track?.title ?? "", lyrics });
  };

  const remove = async (trackId: string) => {
    const result = await window.parrot.removeOwnLyrics(trackId);
    if (!result.ok) {
      console.warn(`[parrot:own-lyrics] removing ${trackId} failed: ${result.error}`);
      toast.error(t("lyricsEditor.saveFailed"));
      return;
    }
    toast.success(t("lyrics.removed"));
  };

  const editorPlaying = editor !== null && playingId === editor.trackId;

  const dialogs = (
    <ParrotLyricsEditorDialog
      open={editor !== null}
      onOpenChange={(open) => !open && setEditor(null)}
      lyrics={editor?.lyrics}
      positionMs={() => (editorPlaying ? clock.read() : 0)}
      playing={editorPlaying && playing}
      onPlayPause={() => (editor && !editorPlaying ? onPlaySong(editor.trackId) : onToggle())}
      onSeek={(ms) => editorPlaying && onSeek(ms)}
      onSave={async (lyrics) => {
        if (!editor) return;
        await save(editor.trackId, lyrics);
        toast.success(t("lyrics.saved"));
      }}
      labels={{
        title: t("lyricsEditor.title", { title: editor?.title ?? "" }),
        body: t("lyricsEditor.body"),
        placeholder: t("lyricsEditor.placeholder"),
        timeLyrics: t("lyricsEditor.timeLyrics"),
        saveWords: t("lyricsEditor.saveWords"),
        back: t("lyricsEditor.back"),
        timingHint: t("lyricsEditor.timingHint"),
        timedCount: t("lyricsEditor.timedCount", { timed: "{timed}", total: "{total}" }),
        tap: t("lyricsEditor.tap"),
        earlier: t("lyricsEditor.earlier"),
        later: t("lyricsEditor.later"),
        replay: t("lyricsEditor.replay"),
        clearTimes: t("lyricsEditor.clearTimes"),
        play: t("lyricsEditor.play"),
        pause: t("lyricsEditor.pause"),
        save: t("lyricsEditor.save"),
        cancel: t("lyricsEditor.cancel"),
        saveFailed: t("lyricsEditor.saveFailed"),
        problems: problemLabels(t),
      }}
    />
  );

  return { openEditor, remove, dialogs, editing: editor !== null };
}
