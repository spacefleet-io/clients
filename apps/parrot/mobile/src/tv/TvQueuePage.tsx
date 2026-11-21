// TV Up next (PAR-TV-09, draft `6-queue`, Chris 2026-11-20): at the left the playing song's cover, "NOW PLAYING", its
// title, artist and wave with the times; at the right "Up next", "Playing from album" and its name, and the songs in the
// order the native player will play them (`useUpNext`, as the phone's queue sheet reads them), each with its cover,
// artist and length. OK on a song skips forward to it, so the songs before it are passed, not lost from the queue.
import React from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { useSkyScroll } from "@space/mobile-shell/components";
import { AudioPlayback, type AudioPlaybackState } from "@space/mobile-audio-playback";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvBody, TvEyebrow, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_TYPE } from "@space/mobile-shell/tv/tokens";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { parrotCoverThumbKey } from "@space/parrot-core";
import { nowPlayingTitles } from "../lib/nowPlaying";
import { ParrotArt } from "../screens/art";
import { usePlayerState } from "../state/usePlayerState";
import { useUpNext } from "../state/useUpNext";
import { TvListCard, TvSongRow, TvTimes, TvWave } from "./TvMusicParts";
import { skipToUpNext } from "./tvModel";

const log = scopeLogger("parrot.tv.queue");

/** Draft `.cover` 520 px; rows 88 px with 60 px covers. */
const COVER = 210;
const ROW = 44;
const ROW_COVER = 30;

const skipNext = () => AudioPlayback.next();

export const TvQueuePage = () => {
  const state = usePlayerState(250);
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  if (!state?.mediaId) {
    return (
      <View style={styles.empty} testID="tv-queue-empty">
        <TvBody muted>{t("parrot.player.nothing")}</TvBody>
      </View>
    );
  }
  return <Queue state={state} trackId={state.mediaId} />;
};

const Queue = ({ state, trackId }: { state: AudioPlaybackState; trackId: string }) => {
  const { t } = useTranslation();
  const next = useUpNext(true, state);
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const skyScroll = useSkyScroll();
  const meta = nowPlayingTitles.get(trackId);
  const duration = state.durationMs > 0 ? state.durationMs : 0;

  return (
    <View style={styles.page} testID="tv-queue">
      <View style={styles.now}>
        <ParrotArt
          seed={meta?.albumId ?? trackId}
          size={COVER * scale}
          radius={12 * scale}
          coverKey={meta?.cover?.coverObjectKey}
          previewKey={meta?.cover ? parrotCoverThumbKey(meta.cover) : null}
        />
        <View style={styles.nowText}>
          <TvEyebrow>{t("shell.nowPlaying.now")}</TvEyebrow>
          <Text style={styles.title} numberOfLines={1}>
            {meta?.title ?? t("parrot.player.unknownSong")}
          </Text>
          <TvBody muted numberOfLines={1}>
            {meta?.artist || t("shell.library.unknownArtist")}
          </TvBody>
        </View>
        <View style={styles.wave}>
          <TvWave seed={trackId} progress={duration > 0 ? state.positionMs / duration : 0} height={24} bars={60} />
          <TvTimes positionMs={state.positionMs} durationMs={duration} size={10} />
        </View>
      </View>
      <View style={styles.list}>
        <TvTitle size="page">{t("shell.nowPlaying.upNext")}</TvTitle>
        {meta?.album ? (
          <TvBody muted numberOfLines={1}>
            {`${t("parrot.player.playingFromAlbum")} ${meta.album}`}
          </TvBody>
        ) : null}
        {next.length === 0 ? (
          <TvBody muted testID="tv-queue-nothing">
            {t("shell.nowPlaying.nothingNext")}
          </TvBody>
        ) : (
          <TvListCard style={styles.card} testID="tv-queue-list">
            <FlatList
              data={next}
              keyExtractor={(id, index) => `${id}:${index}`}
              removeClippedSubviews={false}
              showsVerticalScrollIndicator={false}
              {...skyScroll}
              renderItem={({ item: id, index }) => {
                const song = nowPlayingTitles.get(id);
                return (
                  <TvSongRow
                    testID={`tv-queue-song-${index}`}
                    height={ROW}
                    hasTVPreferredFocus={index === 0}
                    cover={<ParrotArt seed={song?.albumId ?? id} size={ROW_COVER * scale} radius={5 * scale} coverKey={song?.cover ? parrotCoverThumbKey(song.cover) : null} />}
                    title={song?.title ?? t("parrot.player.unknownSong")}
                    subtitle={song?.artist || t("shell.library.unknownArtist")}
                    durationMs={song?.durationMs ?? null}
                    playing={null}
                    onPress={() => {
                      log.info("skip_to", { index, count: next.length });
                      skipToUpNext(index, skipNext).catch((error: unknown) => log.warn("skip_failed", { index, message: error instanceof Error ? error.message : String(error) }));
                    }}
                  />
                );
              }}
            />
          </TvListCard>
        )}
      </View>
    </View>
  );
};

/** Sizes in design dp: draft px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  // Draft `.queue`: columns 520px + the rest, gap 100px, padding 84px 110px.
  page: { flex: 1, flexDirection: "row", gap: 50, paddingVertical: 42, paddingHorizontal: 55 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  now: { width: 210, gap: 14 },
  nowText: { gap: 2 },
  title: { ...TV_TYPE.hero, fontSize: 29, lineHeight: 35, color: TV_COLOR.text },
  wave: { gap: 4 },
  list: { flex: 1, gap: 6 },
  card: { flexShrink: 1, marginTop: 10 },
});
