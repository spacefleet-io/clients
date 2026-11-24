import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { DetailsHeroArt } from "../components/DetailsHeroArt";
import { useNavigation, useRoute } from "@react-navigation/native";
import { CastContext, useDevices } from "react-native-google-cast";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Captions, Cast, Check, ChevronLeft, Clapperboard, Download, ListPlus, Play, X } from "lucide-react-native";
import YoutubePlayer from "react-native-youtube-iframe";
import { getCurrentLanguage, useTranslation } from "@space/mobile-shell/i18n";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { MobileSheetScrollView, useMobileDismissPan } from "@space/mobile-shell/bottom-sheet";
import { MobileRailScroll, MobileSkeletonBlock, MobileSkeletonPulse, MobileSkyLayer } from "@space/mobile-shell/components";
import type { MediaDetails, MediaEpisode } from "@space/shared/libraryTypes";
import { subtitleFetchCopy } from "@space/shared/subtitleFetch";
import { crewLines as toCrewLines } from "@space/shared/libraryCrew";
import { artworkAwaitsSource } from "@space/shared/artworkImage";
import { useArtworkState } from "@space/shared/useArtworkState";
import { MobileArtworkSpinner } from "@space/mobile-shell/artwork-image";
import { RootStackParamList } from "../navigation/AppNavigator";
import { usePlaylistMembership } from "../lib/usePlaylistMembership";
import { useMediaImageSource } from "../lib/useMediaImage";
import { MediaArtwork } from "../components/MediaArtwork";
import { theme } from "../theme/theme";
import { isEpisodeResumable } from "../lib/playback/resume";
import { youtubeWatchUrl } from "../lib/youtubeWatchUrl";
import { formatEpisodeCode } from "../lib/playback/nextEpisode";
import { playEpisode, uploadedEpisodeKeys as uploadedEpisodeKeysOf, uploadedSeasonNumbers as uploadedSeasonNumbersOf } from "../lib/playback/episodeSelection";
import { DownloadPill, EpisodeDownloadButton, seasonRowStatus, useShowSeasonDownloads } from "../components/DownloadControls";
import { usePickerSheet } from "../components/usePickerSheet";
import { BottomSheet } from "../components/BottomSheet";
import { CastPickerSheet } from "../components/CastPickerSheet";
import { SubtitleFetchSheet, type SubtitleFetchRequest } from "../components/SubtitleFetchSheet";
import { useNetworkOnline } from "../lib/networkListener";
import { useLibraryOnline } from "../lib/useLibraryOnline";
import { useDownloadsById, useIsMediaDownloaded } from "../lib/downloads/downloadsStore";
import { episodeKeysOnDevice, playableEpisodeKeysNow, unavailableOffline } from "@space/shared/offlineReach";
import { playButtonAsksTarget } from "../lib/cast/castPicker";
import type { CastTarget } from "../lib/cast/castFlow";
import { markCastPress } from "../lib/cast/castTiming";
import { genreLabelKey } from "../lib/genreLabels";
import { detailsBackTarget } from "../lib/detailsBack";
import { useMediaDetailsState } from "../lib/useMediaDetailsState";
import { PlayOnTvSheet, type TvTarget } from "../components/PlayOnTvSheet";
import { DownloadQualitySheet } from "../components/DownloadQualitySheet";
import { buildStartCommand } from "../lib/playOnTv/startCommand";
import { initials } from "../tv/lib/detailsMedia";
import {
  ACTION_LABEL_LINES,
  actionLabelText,
  episodeRowMark,
  filmPlayLabelKey,
  filmRuntime,
  heroArtwork,
  versionChips,
} from "../lib/phoneDetails";

type Nav = NativeStackNavigationProp<RootStackParamList>;
type DetailsTab = "episodes" | "details";

const RIPPLE_LIGHT = { color: "rgba(219, 223, 240, 0.18)" } as const;
const RIPPLE_DARK = { color: "rgba(18, 20, 33, 0.25)" } as const;

export const MediaDetailsScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const route = useRoute();
  const insets = useSafeAreaInsets();
  const { mediaId } = route.params as { mediaId: string };

  const { playlists, contains: playlistContains, toggle: togglePlaylistItem } = usePlaylistMembership(mediaId);

  const { details, overview, loading, failed, retry, resumeEpisodeId, episodeResume, activeSeason, setActiveSeason } = useMediaDetailsState(
    mediaId,
    navigation,
    "phone",
  );
  const [detailsTab, setDetailsTab] = useState<DetailsTab>("episodes");
  const [activeTrailerKey, setActiveTrailerKey] = useState<string | null>(null);
  const [trailerError, setTrailerError] = useState<"load" | "player" | null>(null);

  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isLandscape = screenWidth > screenHeight;
  const trailerPlayerHeight = Math.round((screenWidth * 9) / 16);
  const sheetOffset = useMemo(() => new Animated.Value(screenHeight), [screenHeight]);
  const trailerPicker = usePickerSheet();
  const playlistPicker = usePickerSheet();
  const seasonPicker = usePickerSheet();
  const castPicker = usePickerSheet();
  const castDevices = useDevices();
  // Episode the play-target picker was opened for (null = the movie / nothing).
  const castEpisodeRef = useRef<string | null>(null);
  const tvPicker = usePickerSheet();
  const seasonDownloads = useShowSeasonDownloads(details);
  const [seasonChecked, setSeasonChecked] = useState<ReadonlySet<number>>(() => new Set());
  const seasonsAllChecked = seasonDownloads.rows.length > 0 && seasonDownloads.rows.every((r) => seasonChecked.has(r.seasonNumber));
  const seasonChanges = useMemo(
    () => seasonDownloads.rows.filter((r) => seasonChecked.has(r.seasonNumber) !== r.initiallyChecked),
    [seasonChecked, seasonDownloads.rows],
  );
  const seasonRemovals = seasonChanges.some((r) => r.initiallyChecked);

  useEffect(() => {
    Animated.timing(sheetOffset, {
      toValue: 0,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [sheetOffset]);

  const closeSheet = useCallback(() => {
    Animated.timing(sheetOffset, {
      toValue: screenHeight,
      duration: 220,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) navigation.goBack();
    });
  }, [navigation, screenHeight, sheetOffset]);

  // Pull-down-to-close from the handle or the hero (the shared sheet drag). The page ScrollView would otherwise grab
  // every vertical drag natively (even at the top), so the scroll waits for the dismiss pan to fail: an upward drag
  // fails it at once, so scrolling stays immediate.
  const scrollAtTopRef = useRef(true);
  const [scrollAtTop, setScrollAtTop] = useState(true);
  const onPageScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const atTop = e.nativeEvent.contentOffset.y <= 1;
    if (atTop === scrollAtTopRef.current) return;
    scrollAtTopRef.current = atTop;
    setScrollAtTop(atTop);
  }, []);

  const makeDismissPan = useMobileDismissPan(sheetOffset, closeSheet);
  const handleDismissPan = useMemo(() => makeDismissPan(true), [makeDismissPan]);
  // Only at the top of the page: further down, a downward drag on the hero means "scroll up".
  const heroDismissPan = useMemo(() => makeDismissPan(scrollAtTop), [makeDismissPan, scrollAtTop]);
  const pageScrollGesture = useMemo(() => Gesture.Native().requireExternalGestureToFail(heroDismissPan), [heroDismissPan]);

  const posterSource = useMediaImageSource(details?.posterPath ?? null, "poster");
  const backdropSource = useMediaImageSource(details?.backdropPath ?? null, "backdrop");
  const heroImage = heroArtwork(
    posterSource.kind === "url" ? posterSource.url : null,
    backdropSource.kind === "url" ? backdropSource.url : null,
  );
  // UX-WAIT-03: a small spinner on the hero while the details or its picture are on their way; the plain fade once
  // there is none or it stalled.
  const heroArt = useArtworkState(
    heroImage
      ? { kind: "url", url: heroImage }
      : !details || posterSource.kind === "pending" || backdropSource.kind === "pending"
        ? { kind: "pending" }
        : { kind: "none" },
  );
  const heroWaiting = artworkAwaitsSource(heroArt.state);

  const isTv = details?.type === "tv";
  // "Get subtitles" (PLAY-SUBGET-01): a film's action cell, an episode row's captions button; searchable only with a catalog id.
  const [subtitleRequest, setSubtitleRequest] = useState<SubtitleFetchRequest | null>(null);
  const closeSubtitleSheet = useCallback(() => setSubtitleRequest(null), []);
  const online = useNetworkOnline();
  const subtitleCopy = subtitleFetchCopy(getCurrentLanguage());
  const canGetSubtitles = details?.catalogId != null;

  const uploadedEpisodeKeys = useMemo(() => uploadedEpisodeKeysOf(details), [details]);
  // OFFL-PLAY-03: offline, only what is downloaded on the phone starts; the rest is greyed and disabled.
  const libraryOnline = useLibraryOnline();
  const { byId: downloadsById } = useDownloadsById();
  const playableEpisodeKeys = useMemo(
    () =>
      playableEpisodeKeysNow(
        libraryOnline,
        uploadedEpisodeKeys,
        episodeKeysOnDevice(details?.files ?? [], (fileId) => downloadsById.get(fileId)?.status === "completed"),
      ),
    [details, downloadsById, libraryOnline, uploadedEpisodeKeys],
  );
  const filmDownloaded = useIsMediaDownloaded(mediaId);
  const filmUnavailable = details?.type === "movie" && unavailableOffline(libraryOnline, filmDownloaded);

  const uploadedSeasonNumbers = useMemo(() => uploadedSeasonNumbersOf(uploadedEpisodeKeys), [uploadedEpisodeKeys]);

  const filteredEpisodes = useMemo(() => {
    if (!details || details.type !== "tv") return [];
    return details.episodes.filter((episode) => episode.seasonNumber === activeSeason);
  }, [activeSeason, details]);

  const genres = useMemo(() => {
    if (!details) return [];
    return details.genres
      .flatMap((id) => {
        const key = genreLabelKey(details.type, id);
        return key ? [t(key)] : [];
      })
      .slice(0, 2);
  }, [details, t]);

  // Episode the Play button starts (and names): last played, else the first one with files.
  const tvPlayEpisode = useMemo(
    () => playEpisode(details, resumeEpisodeId, playableEpisodeKeys),
    [details, resumeEpisodeId, playableEpisodeKeys],
  );

  const playHere = (episodeId?: string | null) => {
    navigation.navigate("Player", {
      mediaId,
      episodeId: episodeId ?? null,
      backdropPath: details?.backdropPath ?? null,
      posterPath: details?.posterPath ?? null,
    });
  };

  // The play button chooses where playback goes (INTG-CAST-01): with no Cast device around it plays on the phone at once.
  const play = (episodeId?: string | null) => {
    if (!playButtonAsksTarget({ devices: castDevices, platform: Platform.OS === "ios" ? "ios" : "android" })) {
      playHere(episodeId);
      return;
    }
    castEpisodeRef.current = episodeId ?? null;
    // The Cast framework on iOS starts discovery by itself only after a tap on its own Cast button, which this app does not
    // show: start it when the picker opens (also the moment iOS asks for Local Network access), so Cast devices appear in it
    // as they are found. It is left running: the Cast screen starts its session by device id, which needs the device still
    // known. On Android the library's call does nothing, and the picker only opens once a device is already listed.
    void CastContext.getDiscoveryManager().startDiscovery().catch(() => undefined);
    castPicker.open();
  };

  const castTo = (target: CastTarget) => {
    markCastPress();
    castPicker.close(() => navigation.navigate("Cast", { mediaId, episodeId: castEpisodeRef.current, target }));
  };

  const playLabel = tvPlayEpisode
    ? t(isEpisodeResumable(episodeResume[tvPlayEpisode.id]) ? "details.resumeEpisode" : "details.playEpisode", {
        code: formatEpisodeCode(tvPlayEpisode.seasonNumber, tvPlayEpisode.episodeNumber),
      })
    : null;

  const handlePlay = () => {
    if (!details) return;
    if (details.type === "movie") {
      if (filmUnavailable) return;
      play();
      return;
    }
    if (tvPlayEpisode) {
      play(tvPlayEpisode.id);
    }
  };

  // "Play on TV" (UX-TV-02): the title the Play button would start, at the phone's resume point, on the chosen TV.
  const playOnTv = (tv: TvTarget) => {
    if (!details) return;
    const episode = details.type === "tv" ? tvPlayEpisode : null;
    if (details.type === "tv" && !episode) return;
    const start = buildStartCommand({ mediaId, details, episode, episodeResume });
    console.info("tv.cast.phone.pick", JSON.stringify({ episode: episode !== null, positionSeconds: start.positionSeconds }));
    const title = episode ? `${details.title} · ${formatEpisodeCode(episode.seasonNumber, episode.episodeNumber)}` : details.title;
    navigation.navigate("TvRemote", { tvPeerId: tv.peerId, tvName: tv.name, title, start, posterPath: details.posterPath ?? null });
  };

  // A Cast/AirPlay row of the "Play on TV" sheet (UX-TV-03) casts what the Play button would start, like its own picker.
  const castFromTvSheet = (target: CastTarget) => {
    const episodeId = details?.type === "tv" ? (tvPlayEpisode?.id ?? null) : null;
    castEpisodeRef.current = episodeId;
    tvPicker.close(() => navigation.navigate("Cast", { mediaId, episodeId, target }));
  };

  const openTrailerPicker = () => {
    if (!details?.trailers.length) return;
    trailerPicker.open();
  };

  const startTrailer = (trailerKey: string) => {
    trailerPicker.close(() => {
      setTrailerError(null);
      setActiveTrailerKey(trailerKey);
    });
  };

  // META-TRAILER-01: when YouTube's embed refuses the trailer, the phone opens its watch page instead (the YouTube app
  // when installed, else the browser); the error text stays only if nothing can open it.
  const handOffTrailer = (trailerKey: string, reason: "load" | "player", detail: string) => {
    const url = youtubeWatchUrl(trailerKey);
    console.warn("details.trailer.embedFailed", JSON.stringify({ mediaId, key: trailerKey, reason, detail }));
    Linking.openURL(url).then(
      () => {
        console.info("details.trailer.handOff", JSON.stringify({ mediaId, key: trailerKey }));
        setActiveTrailerKey(null);
      },
      (error: unknown) => {
        console.warn("details.trailer.handOffFailed", JSON.stringify({ mediaId, key: trailerKey, error: String(error) }));
        setTrailerError(reason);
      },
    );
  };

  const openSeasonPicker = useCallback(() => {
    // Ticks mirror what is offline (or on its way) at the moment the picker opens.
    setSeasonChecked(new Set(seasonDownloads.rows.filter((r) => r.initiallyChecked).map((r) => r.seasonNumber)));
    seasonPicker.open();
  }, [seasonDownloads.rows, seasonPicker]);

  const toggleSeasonChecked = (seasonNumber: number) => {
    setSeasonChecked((prev) => {
      const next = new Set(prev);
      if (next.has(seasonNumber)) next.delete(seasonNumber);
      else next.add(seasonNumber);
      return next;
    });
  };

  const toggleAllSeasons = () => {
    setSeasonChecked(seasonsAllChecked ? new Set() : new Set(seasonDownloads.rows.map((r) => r.seasonNumber)));
  };

  const applySeasonPicker = () => {
    const checked = seasonChecked;
    seasonPicker.close(() => seasonDownloads.apply(checked));
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const target = detailsBackTarget({
        trailerOpen: activeTrailerKey !== null,
        trailerPickerOpen: trailerPicker.visible,
        playlistPickerOpen: playlistPicker.visible,
        seasonPickerOpen: seasonPicker.visible,
      });
      if (target === "trailer") setActiveTrailerKey(null);
      else if (target === "trailerPicker") trailerPicker.close();
      else if (target === "playlistPicker") playlistPicker.close();
      else if (target === "seasonPicker") seasonPicker.close();
      else closeSheet();
      return true;
    });
    return () => sub.remove();
  }, [activeTrailerKey, closeSheet, playlistPicker, seasonPicker, trailerPicker]);

  // "1927 · 2h 33m · Drama · Science fiction" for a film; a show names its seasons in place of a length (UX-PHONE-04).
  const metaParts = useMemo(() => {
    if (!details) return [];
    const runtime = filmRuntime(details);
    const length =
      details.type === "tv"
        ? t("details.runtime.seasons", { count: details.seasons.length })
        : runtime
          ? runtime.hours > 0
            ? t("library.row.runtimeHours", runtime)
            : t("library.row.runtimeMinutes", runtime)
          : null;
    return [details.year, length, ...genres].filter((part): part is string => typeof part === "string" && part.length > 0);
  }, [details, genres, t]);
  // LIB-CREW-01: the director and writers, the same lines as the desktop and web detail pages.
  const crewLines = useMemo(
    () => toCrewLines(details?.crew, { director: t("details.crew.director"), writing: t("details.crew.writing") }),
    [details, t]
  );
  const buttonLabel = playLabel ?? t(filmPlayLabelKey(details?.progressPct ?? 0));

  const canPlayTv = Boolean(tvPlayEpisode);
  const playDisabled = Boolean(isTv && !canPlayTv) || filmUnavailable;
  const activeTrailer =
    details?.trailers.find((trailer) => trailer.key === activeTrailerKey) ?? null;

  return (
    <View style={styles.modalRoot}>
      <Animated.View
        style={[
          styles.backdrop,
          {
            opacity: sheetOffset.interpolate({
              inputRange: [0, screenHeight],
              outputRange: [1, 0],
              extrapolate: "clamp",
            }),
          },
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
      </Animated.View>

      <Animated.View
        style={[
          styles.sheet,
          {
            marginTop: insets.top + 8,
            transform: [{ translateY: sheetOffset }],
          },
        ]}
      >
        <MobileSkyLayer>
        <GestureDetector gesture={handleDismissPan}>
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>

        <GestureDetector gesture={pageScrollGesture}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          onScroll={onPageScroll}
          scrollEventThrottle={16}
        >
          {loading ? (
            <MobileSkeletonPulse style={styles.loadingContent}>
              <MobileSkeletonBlock width="100%" height={340} radius={0} />
              <View style={styles.loadingBody}>
                <MobileSkeletonBlock width="60%" height={26} radius={8} />
                <MobileSkeletonBlock width="35%" height={12} radius={6} />
                <MobileSkeletonBlock width="100%" height={56} radius={18} />
                <MobileSkeletonBlock width="100%" height={12} radius={6} />
                <MobileSkeletonBlock width="90%" height={12} radius={6} />
              </View>
            </MobileSkeletonPulse>
          ) : details ? (
            <>
              <GestureDetector gesture={heroDismissPan}>
              {/* UX-PHONE-04: the artwork edge to edge, fading out at the bottom into the sky, with the title over the fade. */}
              <View style={styles.heroWrap} testID="details-hero">
                <DetailsHeroArt uri={heroImage} />
                {heroWaiting ? <MobileArtworkSpinner /> : null}
                <View style={styles.heroTopRow}>
                  <Pressable
                    testID="details-back"
                    style={styles.heroRoundButton}
                    onPress={closeSheet}
                    accessibilityRole="button"
                    accessibilityLabel={t("details.back")}
                    hitSlop={8}
                  >
                    <ChevronLeft size={28} color={theme.colors.text} strokeWidth={2.75} />
                  </Pressable>
                </View>
                <View style={styles.heroMetaWrap}>
                  <View style={styles.chipRow} testID="details-chips">
                    <View style={[styles.chip, styles.chipType]}>
                      <Text style={[styles.chipText, styles.chipTypeText]}>{isTv ? t("details.type.tv") : t("details.type.movie")}</Text>
                    </View>
                    {versionChips(details).map((label) => (
                      <View key={label} style={styles.chip} testID="details-version-chip">
                        <Text style={styles.chipText}>{label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={styles.title} accessibilityRole="header">
                    {details.title}
                  </Text>
                  <Text style={styles.metaLine} testID="details-meta">
                    {metaParts.join(" · ")}
                  </Text>
                </View>
              </View>
              </GestureDetector>

              <View style={styles.headBlock}>
                <Pressable
                  testID="play-button"
                  style={[styles.playButton, playDisabled && styles.actionDisabled]}
                  onPress={handlePlay}
                  disabled={playDisabled}
                  accessibilityState={{ disabled: playDisabled }}
                  accessibilityLabel={buttonLabel}
                  accessibilityRole="button"
                  android_ripple={RIPPLE_DARK}
                >
                  <Play size={17} color={theme.accentTextHex} fill={theme.accentTextHex} />
                  <Text style={styles.playLabel} numberOfLines={1}>
                    {buttonLabel}
                  </Text>
                </Pressable>

                <View style={styles.actionsGrid}>
                  <View style={styles.actionCell}>
                    <DownloadPill details={details} onPickSeasons={openSeasonPicker} style={styles.roundAction} />
                    <Text style={styles.actionLabel} numberOfLines={ACTION_LABEL_LINES}>
                      {actionLabelText(t("details.actions.download"))}
                    </Text>
                  </View>
                  <Pressable
                    testID="details-playlist-button"
                    style={styles.actionCell}
                    onPress={playlistPicker.open}
                    accessibilityRole="button"
                    accessibilityLabel={t("details.addToPlaylist")}
                  >
                    <View style={styles.roundAction}>
                      <ListPlus size={19} color={theme.colors.text} />
                    </View>
                    <Text style={styles.actionLabel} numberOfLines={ACTION_LABEL_LINES}>
                      {actionLabelText(t("details.actions.playlist"))}
                    </Text>
                  </Pressable>
                  {details.trailers.length > 0 ? (
                    <Pressable
                      testID="details-trailer-button"
                      style={styles.actionCell}
                      onPress={openTrailerPicker}
                      accessibilityRole="button"
                      accessibilityLabel={t("details.trailer.button")}
                    >
                      <View style={styles.roundAction}>
                        <Clapperboard size={19} color={theme.colors.text} />
                      </View>
                      <Text style={styles.actionLabel} numberOfLines={ACTION_LABEL_LINES}>
                        {actionLabelText(t("details.trailer.button"))}
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    testID="play-on-tv-button"
                    style={[styles.actionCell, playDisabled && styles.actionDisabled]}
                    onPress={tvPicker.open}
                    disabled={playDisabled}
                    accessibilityRole="button"
                    accessibilityLabel={t("playOnTv.button")}
                  >
                    <View style={styles.roundAction}>
                      <Cast size={19} color={theme.colors.text} />
                    </View>
                    <Text style={styles.actionLabel} numberOfLines={ACTION_LABEL_LINES}>
                      {actionLabelText(t("playOnTv.button"))}
                    </Text>
                  </Pressable>
                  {!isTv && canGetSubtitles ? (
                    <Pressable
                      testID="details-get-subtitles-button"
                      style={[styles.actionCell, !online && styles.actionDisabled]}
                      onPress={() => setSubtitleRequest({ mediaId, episodeId: null })}
                      disabled={!online}
                      accessibilityRole="button"
                      accessibilityLabel={online ? subtitleCopy.title : `${subtitleCopy.title} · ${subtitleCopy.offline}`}
                      accessibilityState={{ disabled: !online }}
                    >
                      <View style={styles.roundAction}>
                        <Captions size={19} color={theme.colors.text} />
                      </View>
                      <Text style={styles.actionLabel} numberOfLines={ACTION_LABEL_LINES}>
                        {actionLabelText(online ? subtitleCopy.title : `${subtitleCopy.title} · ${subtitleCopy.offline}`)}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>

              {isTv ? (
                <View style={styles.sectionBlock}>
                  <View style={styles.segmentedControl}>
                    <Pressable
                      style={[styles.segment, detailsTab === "episodes" && styles.segmentActive]}
                      onPress={() => setDetailsTab("episodes")}
                    >
                      <Text style={[styles.segmentLabel, detailsTab === "episodes" && styles.segmentLabelActive]}>
                        {t("details.tabs.episodes").toUpperCase()}
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.segment, detailsTab === "details" && styles.segmentActive]}
                      onPress={() => setDetailsTab("details")}
                    >
                      <Text style={[styles.segmentLabel, detailsTab === "details" && styles.segmentLabelActive]}>
                        {t("details.tabs.details").toUpperCase()}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {!isTv || detailsTab === "details" ? (
                overview ? (
                  <View style={styles.sectionBlock}>
                    <Text style={styles.overview}>{overview}</Text>
                  </View>
                ) : null
              ) : null}

              {isTv && detailsTab === "episodes" ? (
                <View style={[styles.sectionBlock, styles.sectionBlockSpacious]}>
                  <MobileRailScroll style={styles.seasonsScroll} contentContainerStyle={styles.seasonsRow}>
                    {details.seasons.map((season) => {
                      const available = uploadedSeasonNumbers.has(season.seasonNumber);
                      return (
                        <Pressable
                          key={season.id}
                          testID={`season-chip-${season.seasonNumber}`}
                          style={[
                            styles.seasonChip,
                            activeSeason === season.seasonNumber && styles.seasonChipActive,
                            !available && styles.seasonChipDisabled,
                          ]}
                          onPress={() => setActiveSeason(season.seasonNumber)}
                          disabled={!available}
                        >
                          <Text
                            style={[
                              styles.seasonChipText,
                              activeSeason === season.seasonNumber && styles.seasonChipTextActive,
                              !available && styles.seasonChipTextDisabled,
                            ]}
                          >
                            {t("details.seasonShort", { number: season.seasonNumber })}
                          </Text>
                          {seasonDownloads.downloadedSeasons.has(season.seasonNumber) ? (
                            <View
                              testID={`season-offline-${season.seasonNumber}`}
                              style={styles.seasonChipStamp}
                              accessibilityLabel={t("downloads.picker.downloaded")}
                            >
                              <Download size={9} color={theme.accentTextHex} strokeWidth={3} />
                            </View>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </MobileRailScroll>

                  <View style={styles.episodesList}>
                    {filteredEpisodes.map((episode) => {
                      const available = playableEpisodeKeys.has(
                        `${episode.seasonNumber}-${episode.episodeNumber}`
                      );
                      return (
                        <EpisodeRow
                          key={episode.id}
                          episode={episode}
                          onPress={() => play(episode.id)}
                          disabled={!available}
                          mark={episodeRowMark(episodeResume[episode.id])}
                          details={details}
                          getSubtitles={
                            available && canGetSubtitles
                              ? { online, label: online ? subtitleCopy.title : `${subtitleCopy.title} · ${subtitleCopy.offline}`, onPress: () => setSubtitleRequest({ mediaId, episodeId: episode.id }) }
                              : null
                          }
                        />
                      );
                    })}
                    {filteredEpisodes.length === 0 ? (
                      <Text style={styles.emptyLine}>{t("details.episodesEmpty")}</Text>
                    ) : null}
                  </View>
                </View>
              ) : null}

              {!isTv || detailsTab === "details" ? (
                <>
                  {crewLines.length > 0 ? (
                    <View style={styles.sectionBlock} testID="details-crew">
                      <Text style={styles.sectionTitle}>{t("details.crew.title").toUpperCase()}</Text>
                      {crewLines.map((line) => (
                        <Text key={line.key} style={styles.crewLine} testID={`details-crew-${line.key}`}>
                          <Text style={styles.crewLabel}>{line.label}</Text> {line.names.join(", ")}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  {details.cast.length > 0 ? (
                    <View style={[styles.sectionBlock, styles.sectionBlockSpacious]}>
                      <Text style={styles.sectionTitle}>{t("details.cast").toUpperCase()}</Text>
                      <MobileRailScroll contentContainerStyle={styles.castRow}>
                        {details.cast.slice(0, 16).map((member) => (
                          <CastAvatar
                            key={member.id}
                            profilePath={member.profilePath}
                            name={member.name}
                          />
                        ))}
                      </MobileRailScroll>
                    </View>
                  ) : null}
                </>
              ) : null}

              <View style={{ height: 22 }} />
            </>
          ) : (
            // The read threw or found nothing (`failed`): say so and offer Retry, never a blank sheet.
            <View style={styles.failedBody} testID={failed ? "details-failed" : undefined}>
              <Text style={styles.failedText}>{t("player.error.loadFailed")}</Text>
              <Pressable
                style={styles.retryButton}
                android_ripple={RIPPLE_DARK}
                onPress={retry}
                accessibilityRole="button"
                testID="details-retry"
              >
                <Text style={styles.playLabel}>{t("player.error.retry")}</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
        </GestureDetector>
        </MobileSkyLayer>
      </Animated.View>

      <Modal
        visible={Boolean(activeTrailer)}
        animationType="slide"
        transparent={false}
        statusBarTranslucent
        presentationStyle="fullScreen"
        // Android routes Back to the Modal, not BackHandler: close only the trailer.
        onRequestClose={() => setActiveTrailerKey(null)}
      >
        {/* UX-CRASH-01: a crash inside the trailer player closes it; the window guard says why. */}
        <MobileRenderBoundary name="modal:trailer" onDismiss={() => setActiveTrailerKey(null)}>
        {/* A Modal is its own window: measure its insets there (the page's can be stale after the player toggled the bars). */}
        <SafeAreaProvider>
        <View style={styles.embeddedTrailerRoot}>
          <TrailerCloseButton onPress={() => setActiveTrailerKey(null)} />
          {activeTrailer ? (
            trailerError ? (
              <View style={styles.trailerErrorWrap}>
                <Text style={styles.trailerErrorText}>{t(`details.trailer.errors.${trailerError}`)}</Text>
              </View>
            ) : (
              <View style={styles.embeddedTrailerPlayerWrap}>
                <YoutubePlayer
                  style={styles.embeddedTrailerWebview}
                  width={screenWidth}
                  height={isLandscape ? screenHeight : Math.min(trailerPlayerHeight, screenHeight)}
                  play
                  videoId={activeTrailer.key}
                  initialPlayerParams={{
                    controls: true,
                    modestbranding: true,
                    rel: false,
                    fs: true,
                    playsinline: true,
                  }}
                  webViewProps={{
                    scrollEnabled: false,
                    bounces: false,
                    overScrollMode: "never",
                    nestedScrollEnabled: false,
                  }}
                  webViewStyle={styles.embeddedTrailerWebview}
                  forceAndroidAutoplay
                  onChangeState={(state: string) => {
                    if (state === "ended") {
                      setActiveTrailerKey(null);
                    }
                  }}
                  onError={(error: string) => {
                    handOffTrailer(activeTrailer.key, "load", error);
                  }}
                  onWebViewError={(error: unknown) => {
                    handOffTrailer(activeTrailer.key, "player", String(error));
                  }}
                />
              </View>
            )
          ) : null}
        </View>
        </SafeAreaProvider>
        </MobileRenderBoundary>
      </Modal>

      <BottomSheet sheet={trailerPicker} sheetStyle={styles.pickerSheet}>
        <Text style={styles.pickerTitle}>{t("details.trailer.pickerTitle")}</Text>
        <View style={styles.pickerList}>
          {details?.trailers.map((trailer) => (
            <Pressable
              key={trailer.key}
              style={styles.pickerRow}
              onPress={() => startTrailer(trailer.key)}
            >
              <Text style={styles.pickerRowName} numberOfLines={1}>
                {trailer.name ?? t("details.trailer.fallbackName")}
              </Text>
              <Text style={styles.pickerRowMeta}>{trailer.language.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
      </BottomSheet>

      <BottomSheet sheet={playlistPicker} sheetStyle={styles.pickerSheet}>
        <Text style={styles.pickerTitle}>{t("details.playlistPicker.title")}</Text>
        <View style={styles.pickerList}>
          {playlists.map((playlist) => {
            const checked = Boolean(playlistContains[playlist.id]);
            return (
              <Pressable
                key={playlist.id}
                style={styles.pickerRow}
                onPress={() => void togglePlaylistItem(playlist.id)}
              >
                <Text style={styles.pickerRowName}>{playlist.name}</Text>
                <View style={[styles.checkPill, checked && styles.checkPillActive]}>
                  {checked ? <Check size={12} color={theme.colors.bg} /> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      </BottomSheet>

      <CastPickerSheet
        sheet={castPicker}
        devices={castDevices}
        onPhone={() => castPicker.close(() => playHere(castEpisodeRef.current))}
        onTarget={castTo}
      />

      <BottomSheet sheet={seasonPicker} testID="season-download-picker" sheetStyle={styles.pickerSheet}>
        <View style={styles.pickerTitleRow}>
          <Text style={styles.pickerTitle}>{t("downloads.picker.title")}</Text>
          <Pressable testID="season-picker-toggle-all" onPress={toggleAllSeasons} hitSlop={8} accessibilityRole="button">
            <Text style={styles.inlineActionText}>
              {(seasonsAllChecked ? t("downloads.picker.unselectAll") : t("downloads.picker.selectAll")).toUpperCase()}
            </Text>
          </Pressable>
        </View>
        <MobileSheetScrollView style={styles.seasonPickerScroll} contentContainerStyle={styles.pickerList}>
          {seasonDownloads.rows.map((row) => {
            const checked = seasonChecked.has(row.seasonNumber);
            const name =
              row.seasonNumber === 0
                ? t("downloads.picker.specials")
                : t("downloads.picker.season", { number: row.seasonNumber });
            return (
              <Pressable
                key={row.seasonNumber}
                testID={`season-picker-row-${row.seasonNumber}`}
                style={styles.pickerRow}
                onPress={() => toggleSeasonChecked(row.seasonNumber)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={name}
              >
                <View style={styles.seasonPickerRowText}>
                  <Text style={styles.pickerRowName}>{name}</Text>
                  <Text style={styles.pickerRowMeta}>{seasonRowStatus(row, t)}</Text>
                </View>
                <View style={[styles.checkPill, checked && styles.checkPillActive]}>
                  {checked ? <Check size={12} color={theme.colors.bg} /> : null}
                </View>
              </Pressable>
            );
          })}
        </MobileSheetScrollView>
        <Pressable
          testID="season-picker-apply"
          style={[styles.seasonPickerApply, seasonChanges.length === 0 && styles.actionDisabled]}
          onPress={applySeasonPicker}
          disabled={seasonChanges.length === 0}
          accessibilityRole="button"
          android_ripple={RIPPLE_DARK}
        >
          <Text style={styles.seasonPickerApplyText}>
            {seasonRemovals ? t("downloads.picker.save") : t("downloads.picker.download")}
          </Text>
        </Pressable>
      </BottomSheet>

      <PlayOnTvSheet sheet={tvPicker} devices={castDevices} onPick={playOnTv} onCast={castFromTvSheet} />
      <DownloadQualitySheet />
      <SubtitleFetchSheet request={subtitleRequest} onClosed={closeSubtitleSheet} />
    </View>
  );
};

/** Trailer close button, kept clear of the notch / status bar area of the trailer's own window. */
const TrailerCloseButton = ({ onPress }: { onPress: () => void }) => {
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      style={[styles.trailerClose, { top: insets.top + 8, right: insets.right + 20 }]}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
    >
      <X size={20} color={theme.colors.text} />
    </Pressable>
  );
};

const EpisodeRow = ({
  episode,
  onPress,
  disabled,
  mark,
  details,
  getSubtitles,
}: {
  episode: MediaEpisode;
  onPress: () => void;
  disabled: boolean;
  mark: ReturnType<typeof episodeRowMark>;
  details: MediaDetails;
  getSubtitles: { online: boolean; label: string; onPress: () => void } | null;
}) => {
  const { t } = useTranslation();
  const labelParams = { number: episode.episodeNumber, name: episode.name, percent: Math.round(mark.progressPct) };
  const label =
    mark.kind === "watched"
      ? t("details.episode.labelWatched", labelParams)
      : mark.kind === "progress"
      ? t("details.episode.labelProgress", labelParams)
      : t("details.episode.label", labelParams);

  return (
    <Pressable
      style={[styles.episodeRow, disabled && styles.episodeRowDisabled]}
      testID={`episode-row-${episode.seasonNumber}-${episode.episodeNumber}`}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      android_ripple={RIPPLE_LIGHT}
    >
      <View style={styles.episodeStillWrap}>
        <MediaArtwork path={episode.stillPath} kind="still" style={styles.episodeStill} />
        <View style={styles.episodePlayPill}>
          <Play size={10} color={theme.colors.text} fill={theme.colors.text} />
        </View>
        {mark.kind === "watched" ? (
          <View testID={`episode-watched-${episode.id}`} style={styles.episodeWatchedBadge}>
            <Check size={14} color={theme.accentTextHex} strokeWidth={3} />
          </View>
        ) : null}
        {mark.kind !== "none" ? (
          <View testID={`episode-progress-${episode.id}`} style={styles.episodeProgressTrack}>
            <View style={[styles.episodeProgressFill, { width: `${mark.progressPct}%` }]} />
          </View>
        ) : null}
      </View>
      <View style={styles.episodeBody}>
        <Text style={[styles.episodeTitle, disabled && styles.episodeDisabledText]} numberOfLines={1}>
          {t("details.episode.title", { number: episode.episodeNumber, name: episode.name })}
        </Text>
        {episode.overview ? (
          <Text style={[styles.episodeOverview, disabled && styles.episodeDisabledText]} numberOfLines={2}>
            {episode.overview}
          </Text>
        ) : null}
      </View>
      {getSubtitles ? (
        <Pressable
          testID="episode-get-subtitles"
          style={[styles.episodeSubtitlesButton, !getSubtitles.online && styles.actionDisabled]}
          onPress={getSubtitles.onPress}
          disabled={!getSubtitles.online}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={getSubtitles.label}
          accessibilityState={{ disabled: !getSubtitles.online }}
        >
          <Captions size={18} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      <EpisodeDownloadButton details={details} seasonNumber={episode.seasonNumber} episodeNumber={episode.episodeNumber} />
    </Pressable>
  );
};

const CastAvatar = ({ profilePath, name }: { profilePath: string | null; name: string }) => (
    <View style={styles.castCard}>
      <View style={styles.castAvatarWrap}>
        {/* Initials while there is no photo, or for good when the library has none (UX-PHONE-04). */}
        <MediaArtwork path={profilePath} kind="profile" style={styles.castAvatar} fallback={<Text style={styles.castInitials}>{initials(name)}</Text>} />
      </View>
      <Text style={styles.castName} numberOfLines={1}>
        {name}
      </Text>
    </View>
);

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    // App navy, not black: the strip above the sheet sits under the notch and a
    // black scrim made the cut-out stand out.
    backgroundColor: "rgba(18,20,33,0.88)",
  },
  sheet: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    borderTopLeftRadius: 40,
    borderTopRightRadius: 40,
    overflow: "hidden",
  },
  handleWrap: {
    position: "absolute",
    top: 8,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 10,
    paddingVertical: 8,
  },
  handle: {
    width: 46,
    height: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.32)",
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingBottom: 12,
  },
  loadingContent: {
    minHeight: 520,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: {
    color: theme.colors.textMuted,
    fontSize: 13,
  },
  heroWrap: {
    height: 360,
    position: "relative",
  },
  heroTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 28,
    paddingHorizontal: 14,
  },
  // UX-PHONE-04: big and dark enough to find on any poster (the 38 px, 40 % black one was lost on light art).
  heroRoundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.62)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.28)",
    alignItems: "center",
    justifyContent: "center",
  },
  heroMetaWrap: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 0,
  },
  headBlock: {
    paddingHorizontal: 20,
    paddingTop: 16,
    marginBottom: 20,
    alignItems: "stretch",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
  },
  chip: {
    height: 22,
    borderRadius: 6,
    paddingHorizontal: 8,
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceRaised,
  },
  chipType: {
    backgroundColor: theme.colors.accentSoft,
  },
  chipText: {
    color: theme.colors.text,
    fontSize: 11.5,
    fontWeight: "700",
    opacity: 0.85,
  },
  chipTypeText: {
    color: theme.colors.accent,
    opacity: 1,
  },
  title: {
    color: theme.colors.text,
    fontSize: 32,
    lineHeight: 36,
    fontWeight: "800",
    textAlign: "center",
    marginTop: 8,
    fontFamily: theme.font.family.display,
    textShadowColor: "rgba(0,0,0,0.55)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 8,
  },
  metaLine: {
    color: theme.colors.textMuted,
    fontSize: 13.5,
    textAlign: "center",
    marginTop: 4,
  },
  playButton: {
    height: 50,
    borderRadius: 14,
    marginTop: 16,
    backgroundColor: theme.colors.accent,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  actionsGrid: {
    flexDirection: "row",
    marginTop: 14,
  },
  actionCell: {
    flex: 1,
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 2,
  },
  roundAction: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 0,
    backgroundColor: theme.colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  // Centred lines that break at words and hyphens, never an ellipsis: "Bande-annonce", "Lire sur la TV", "Chercher des sous-titres" (UX-PHONE-04).
  actionLabel: {
    color: theme.colors.textMuted,
    fontSize: 11.5,
    lineHeight: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  playLabel: {
    color: theme.accentTextHex,
    fontSize: 15,
    fontWeight: "800",
    fontFamily: theme.font.family.sans,
  },
  actionDisabled: {
    opacity: 0.35,
  },
  episodeSubtitlesButton: {
    width: 36,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionBlock: {
    paddingHorizontal: 16,
    marginBottom: 22,
    gap: 10,
  },
  sectionBlockSpacious: {
    marginBottom: 28,
  },
  sectionTitle: {
    color: theme.colors.textMuted,
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "900",
    fontFamily: theme.font.family.sans,
  },
  inlineActionText: {
    color: theme.colors.accent,
    fontSize: 11,
    letterSpacing: 1.1,
    fontWeight: "800",
  },
  crewLine: {
    color: theme.colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  crewLabel: {
    color: theme.colors.text,
    fontWeight: "600",
  },
  overview: {
    color: theme.colors.text,
    fontSize: 14,
    lineHeight: 21,
  },
  segmentedControl: {
    flexDirection: "row",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
    backgroundColor: theme.colors.surface,
    padding: 5,
  },
  segment: {
    flex: 1,
    height: 38,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  segmentLabel: {
    color: theme.colors.textMuted,
    fontSize: 11,
    letterSpacing: 1.1,
    fontWeight: "800",
  },
  segmentLabelActive: {
    color: theme.colors.text,
  },
  // The 6dp inset leaves room for the offline stamp on a chip's top-left corner (a ScrollView clips its content);
  // the negative margin keeps the chips aligned with the rest of the section.
  seasonsScroll: {
    marginTop: -6,
    marginLeft: -6,
  },
  seasonsRow: {
    gap: 8,
    paddingTop: 6,
    paddingLeft: 6,
    paddingRight: 8,
  },
  seasonChip: {
    height: 36,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  seasonChipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accentSoft,
  },
  seasonChipDisabled: {
    opacity: 0.35,
  },
  seasonChipText: {
    color: theme.colors.textMuted,
    fontSize: 11,
    letterSpacing: 1,
    fontWeight: "800",
  },
  seasonChipTextActive: {
    color: theme.colors.accent,
  },
  seasonChipTextDisabled: {
    color: theme.colors.textDim,
  },
  seasonChipStamp: {
    position: "absolute",
    top: -6,
    left: -6,
    borderWidth: 2,
    borderColor: theme.colors.bg,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  episodesList: {
    gap: 10,
  },
  episodeRow: {
    flexDirection: "row",
    gap: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
    backgroundColor: theme.colors.surface,
    borderRadius: 18,
    padding: 10,
  },
  episodeRowDisabled: {
    opacity: 0.35,
  },
  episodeStillWrap: {
    width: 132,
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceRaised,
  },
  episodeStill: {
    width: "100%",
    height: "100%",
  },
  episodePlayPill: {
    position: "absolute",
    right: 6,
    bottom: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "rgba(13,17,23,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },
  episodeProgressTrack: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 4,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  episodeProgressFill: {
    height: 4,
    backgroundColor: theme.colors.accent,
  },
  episodeWatchedBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingBody: {
    paddingHorizontal: 20,
    paddingTop: 18,
    gap: 12,
  },
  failedBody: {
    paddingHorizontal: 20,
    paddingVertical: 64,
    alignItems: "center",
    gap: 20,
  },
  failedText: {
    color: theme.colors.textMuted,
    fontSize: 15,
    textAlign: "center",
    fontFamily: theme.font.family.sans,
  },
  retryButton: {
    height: 48,
    minWidth: 160,
    borderRadius: 16,
    paddingHorizontal: 24,
    backgroundColor: theme.colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  episodeBody: {
    flex: 1,
    justifyContent: "center",
    gap: 4,
  },
  episodeTitle: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  episodeOverview: {
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  episodeDisabledText: {
    color: theme.colors.textDim,
  },
  emptyLine: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  castRow: {
    gap: 14,
    paddingRight: 12,
  },
  castCard: {
    width: 72,
    gap: 6,
    alignItems: "center",
  },
  castAvatarWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  castAvatar: {
    width: "100%",
    height: "100%",
  },
  castInitials: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  castName: {
    color: theme.colors.text,
    fontSize: 11.5,
    fontWeight: "600",
    textAlign: "center",
  },
  embeddedTrailerRoot: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
  },
  embeddedTrailerPlayerWrap: {
    width: "100%",
    alignItems: "center",
  },
  embeddedTrailerWebview: {
    width: "100%",
    backgroundColor: "#000",
  },
  trailerErrorWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  trailerErrorText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    textAlign: "center",
  },
  trailerClose: {
    position: "absolute",
    top: 18,
    right: 20,
    zIndex: 20,
    elevation: 20,
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(16,23,34,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  // The details page pickers keep their roomier padding over the shared sheet's.
  pickerSheet: {
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  pickerTitle: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "800",
    fontFamily: theme.font.family.display,
  },
  pickerList: {
    gap: 8,
  },
  pickerRow: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceRaised,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
  },
  pickerRowName: {
    color: theme.colors.text,
    fontSize: 13,
    fontWeight: "700",
    flex: 1,
  },
  pickerRowMeta: {
    color: theme.colors.textDim,
    fontSize: 11,
    letterSpacing: 1,
    fontWeight: "800",
  },
  pickerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  seasonPickerScroll: {
    maxHeight: 360,
  },
  seasonPickerRowText: {
    flex: 1,
    gap: 3,
    paddingVertical: 10,
  },
  seasonPickerApply: {
    height: 52,
    borderRadius: 18,
    backgroundColor: theme.colors.accent,
    justifyContent: "center",
    alignItems: "center",
    marginTop: 4,
  },
  seasonPickerApplyText: {
    color: theme.colors.bg,
    fontSize: 15,
    fontWeight: "800",
  },
  checkPill: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkPillActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
});
