// TV Now playing (PAR-TV-07, draft `3b-now-cover`, Chris 2026-11-20): the big cover at the left; at the right "PLAYING
// FROM ALBUM" and the album, the song's title and artist, its wave with the times, the controls (shuffle, previous, the
// big green play or pause, next, repeat), the heart, Lyrics and Up next; under a line, the line being sung in green and
// the next one dimmed, when the song has synced lyrics. Lyrics opens the full-screen lyrics, Up next the queue; Back from
// there lands on the button that opened them (the page stays mounted, hidden, under them).
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Heart, ListMusic, MicVocal, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react-native";
import { AudioPlayback, showsPause, type AudioPlaybackState } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvPillButton } from "@space/mobile-shell/tv/TvPillButton";
import { TvBody, TvEyebrow } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_TYPE, useTvAccent } from "@space/mobile-shell/tv/tokens";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { nextRepeatMode, parrotCoverThumbKey } from "@space/parrot-core";
import { nowPlayingTitles } from "../lib/nowPlaying";
import { isRecovering, setPlaybackShuffle } from "../lib/playback";
import { ParrotArt } from "../screens/art";
import { usePlaylistEditor } from "../state/playlistEditor";
import { usePlayerState } from "../state/usePlayerState";
import { useTrackLyrics } from "../state/useTrackLyrics";
import { TvRoundButton, TvTimes, TvWave } from "./TvMusicParts";
import { lyricsPeek } from "./tvModel";
import { useTvPages } from "./tvPages";

const log = scopeLogger("parrot.tv.now");

/** Draft `.cover` 560 px; `.ctl` 76 px, `.ctl.play` 104 px. */
const COVER = 280;
const CONTROL = 38;
const PLAY = 52;

const failed = (action: string) => (error: unknown) => log.warn("control_failed", { action, message: error instanceof Error ? error.message : String(error) });

/** The shared transport: shuffle, previous, play or pause, next, repeat (also used by the lyrics page). Play or pause takes
 * the first focus unless `preferPlay` is off. */
export const TvTransport = ({ state, withShuffle = true, withRepeat = true, preferPlay = true }: { state: AudioPlaybackState; withShuffle?: boolean; withRepeat?: boolean; preferPlay?: boolean }) => {
  const { t } = useTranslation();
  const pause = showsPause(state);
  const repeatLabel = state.repeat === "one" ? t("shell.player.repeatOne") : state.repeat === "all" ? t("shell.player.repeatAll") : t("shell.player.repeatOff");
  return (
    <>
      {withShuffle ? (
        <TvRoundButton testID="tv-now-shuffle" icon={Shuffle} size={CONTROL} label={t("shell.player.shuffle")} active={state.shuffle} onPress={() => void setPlaybackShuffle(!state.shuffle).catch(failed("shuffle"))} />
      ) : null}
      <TvRoundButton testID="tv-now-previous" icon={SkipBack} filled size={CONTROL} label={t("parrot.player.previous")} onPress={() => void AudioPlayback.previous().catch(failed("previous"))} />
      <TvRoundButton
        testID="tv-now-play"
        icon={pause ? Pause : Play}
        filled
        primary
        size={PLAY}
        hasTVPreferredFocus={preferPlay}
        label={pause ? t("player.controls.pause") : t("player.controls.play")}
        onPress={() => void (pause ? AudioPlayback.pause() : AudioPlayback.play()).catch(failed(pause ? "pause" : "play"))}
      />
      <TvRoundButton testID="tv-now-next" icon={SkipForward} filled size={CONTROL} label={t("parrot.player.next")} onPress={() => void AudioPlayback.next().catch(failed("next"))} />
      {withRepeat ? (
        <TvRoundButton
          testID="tv-now-repeat"
          icon={state.repeat === "one" ? Repeat1 : Repeat}
          size={CONTROL}
          label={repeatLabel}
          active={state.repeat !== "off"}
          onPress={() => void AudioPlayback.setRepeatMode(nextRepeatMode(state.repeat)).catch(failed("repeat"))}
        />
      ) : null}
    </>
  );
};

/** The heart of the song playing (PAR-PL-02). */
export const TvLikeButton = ({ trackId }: { trackId: string }) => {
  const { t } = useTranslation();
  const editor = usePlaylistEditor();
  const liked = editor.liked(trackId);
  return (
    <TvRoundButton
      testID="tv-now-like"
      icon={Heart}
      filled={liked}
      active={liked}
      size={CONTROL}
      label={liked ? t("shell.playlists.unlike") : t("shell.playlists.like")}
      onPress={() => {
        log.info("like", { trackId, liked: !liked });
        editor.toggleLike(trackId);
      }}
    />
  );
};

/** `shown`: false while the lyrics or Up next cover it. */
export const TvNowPlayingPage = ({ shown }: { shown: boolean }) => {
  const state = usePlayerState(250);
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  if (!state?.mediaId) {
    return (
      <View style={styles.empty} testID="tv-now-empty">
        <TvBody muted>{t("parrot.player.nothing")}</TvBody>
      </View>
    );
  }
  return <NowPlaying state={state} trackId={state.mediaId} shown={shown} />;
};

type Opened = "lyrics" | "queue" | null;

const NowPlaying = ({ state, trackId, shown }: { state: AudioPlaybackState; trackId: string; shown: boolean }) => {
  const { t } = useTranslation();
  const { push } = useTvPages();
  // The page opened from here: as the page shows again its button takes the focus back (a focus guide forgets the view
  // it last focused once hidden on Apple TV, and would land on shuffle).
  const [opened, setOpened] = useState<Opened>(null);
  const open = (kind: "lyrics" | "queue") => {
    log.info("open", { page: kind });
    setOpened(kind);
    push({ kind });
  };
  const { view } = useTrackLyrics(trackId);
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const accent = useTvAccent().color;
  const meta = nowPlayingTitles.get(trackId);
  const duration = state.durationMs > 0 ? state.durationMs : 0;
  const peek = lyricsPeek(view, state.positionMs);

  return (
    <View style={styles.page} testID="tv-now-playing">
      <ParrotArt
        seed={meta?.albumId ?? trackId}
        size={COVER * scale}
        radius={12 * scale}
        coverKey={meta?.cover?.coverObjectKey}
        previewKey={meta?.cover ? parrotCoverThumbKey(meta.cover) : null}
      />
      <View style={styles.info}>
        <View style={styles.from}>
          <TvEyebrow>{t("parrot.player.playingFromAlbum")}</TvEyebrow>
          <TvBody muted numberOfLines={1}>
            {meta?.album ?? ""}
          </TvBody>
        </View>
        <Text style={styles.title} numberOfLines={1} testID="tv-now-title">
          {meta?.title ?? t("parrot.player.unknownSong")}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {meta?.artist || t("shell.library.unknownArtist")}
        </Text>
        <View style={styles.wave}>
          <TvWave seed={trackId} progress={duration > 0 ? state.positionMs / duration : 0} height={36} bars={96} />
          <TvTimes positionMs={state.positionMs} durationMs={duration} size={11} />
        </View>
        <View style={styles.controls}>
          <TvTransport state={state} preferPlay={shown && opened === null} />
          <View style={styles.spacer} />
          <TvLikeButton trackId={trackId} />
          <TvPillButton testID="tv-now-lyrics" icon={MicVocal} label={t("shell.player.lyrics")} hasTVPreferredFocus={shown && opened === "lyrics"} onPress={() => open("lyrics")} />
          <TvPillButton testID="tv-now-up-next" icon={ListMusic} label={t("shell.nowPlaying.upNext")} hasTVPreferredFocus={shown && opened === "queue"} onPress={() => open("queue")} />
        </View>
        {/* The raw player code goes to the log only, never the screen (PAR-PLAY-12, UX-COPY-02). */}
        {state.error && !isRecovering(state) ? <TvBody style={{ color: TV_COLOR.danger }}>{t("parrot.player.error")}</TvBody> : null}
        {peek ? (
          <View style={styles.peek} testID="tv-now-lyrics-peek">
            <Text style={[styles.peekLine, { color: accent }]} numberOfLines={1}>
              {peek.now}
            </Text>
            <Text style={[styles.peekLine, styles.peekNext]} numberOfLines={1}>
              {peek.next}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
};

/** Sizes in design dp: draft px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  // Draft `.now`: columns 560px + the rest, gap 90px, padding 0 120px, centred.
  page: { flex: 1, flexDirection: "row", alignItems: "center", gap: 45, paddingHorizontal: 60 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  info: { flex: 1 },
  from: { gap: 2, marginBottom: 14 },
  title: { ...TV_TYPE.hero, fontSize: 46, lineHeight: 54, color: TV_COLOR.text },
  artist: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 16, lineHeight: 21, color: TV_COLOR.muted, marginTop: 2 },
  wave: { gap: 6, marginTop: 20 },
  controls: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 20 },
  spacer: { flex: 1 },
  // Draft `.peek`: margin-top 48px, a thin line above, lines 34px.
  peek: { marginTop: 24, paddingTop: 16, borderTopWidth: 0.75, borderTopColor: TV_COLOR.borderSoft, gap: 4 },
  peekLine: { fontFamily: TV_TYPE.hero.fontFamily, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  peekNext: { color: "rgba(255, 255, 255, 0.3)" },
});
