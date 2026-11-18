import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { focusDestination, type TvViewInstance } from "../lib/tvViewInstance";
import Svg, { Defs, Image as SvgImage, LinearGradient, Mask, Rect, Stop } from "react-native-svg";
import { ChevronLeft, Clapperboard, Ellipsis, ListPlus, Play, RotateCw, Tag } from "lucide-react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "@space/mobile-shell/i18n";
import { crewPeople } from "@space/shared/libraryCrew";
import type { MediaCastMember } from "@space/shared/libraryTypes";
import { useMediaDetailsState } from "../../lib/useMediaDetailsState";
import { usePlaylistMembership } from "../../lib/usePlaylistMembership";
import { genreLabelKey } from "../../lib/genreLabels";
import { SVG_IMAGE_MASK_BOX } from "../../lib/svgImageMask";
import { formatEpisodeCode } from "../../lib/playback/nextEpisode";
import { episodeFileKey, playEpisode, uploadedEpisodeKeys, uploadedSeasonNumbers } from "../../lib/playback/episodeSelection";
import { COMPLETED_PCT_THRESHOLD } from "@space/shared/playbackResume";
import { isEpisodeResumable } from "../../lib/playback/resume";
import { useMediaImage } from "../../lib/useMediaImage";
import { MediaArtwork } from "../../components/MediaArtwork";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { useLibraryActions, useLibraryData } from "../../store/library";
import { theme } from "../../theme/theme";
import { TvFocusable } from "../components/TvFocusable";
import { TvListDialog, type TvListDialogItem } from "../components/TvListDialog";
import { TvPosterCard } from "../components/TvPosterCard";
import { TvDetailsCast } from "../components/details/TvDetailsCast";
import { TvDetailsEpisodes } from "../components/details/TvDetailsEpisodes";
import { TvEpisodePanel } from "../components/details/TvEpisodePanel";
import { TvTrailerQr, trailerShownAsQr } from "../components/details/TvTrailerQr";
import { TvMediaTracksBlock } from "../components/details/TvMediaTracksBlock";
import {
  episodeMediaBlocks,
  formatStarRating,
  minutesLeft,
  movieMediaBlock,
  runtimeParts,
  similarTitles,
  tvDetailsTabs,
  tvVersionChips,
  youtubeTrailer,
  type TvDetailsTab,
} from "../lib/detailsMedia";
import { currentTvSection, requestTvSection, tvBackLabelKey, type TvSectionId } from "../lib/tvSection";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TV_COLOR, TV_FONT, TV_RADII, TV_SPACE, TvIconButton, TvPillButton, TvTopBar } from "../ui";

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Design dp (mockup px halved, scaled with the TV, UX-TV-13): the poster beside the title (mockup 330 px). */
export const TV_DETAILS_POSTER_WIDTH = 165;
/** A More like this card (UX-TV-40). */
const SIMILAR_CARD_WIDTH = 88;

const TAB_LABEL_KEYS: Record<TvDetailsTab, string> = {
  episodes: "tvShell.details.tabs.episodes",
  cast: "tvShell.details.tabs.cast",
  versions: "tvShell.details.tabs.versions",
  similar: "tvShell.details.tabs.similar",
};

const formatDate = (iso: string | null | undefined, language: string): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(language, { year: "numeric", month: "short", day: "numeric" });
};

/**
 * The title's wide picture, faint behind the right of the page and fading out to the left and the bottom so the sky shows
 * through (UX-TV-06, mockup `.backdrop`: 72 % of the width, 30 % opacity). One SVG mask, so the picture itself fades
 * instead of a dark band being painted over the stars: white fading in from the left, with black rising from the bottom
 * drawn over it. TV-DETAILS-BACKDROP-001: react-native-svg on Android draws nothing for a masked image inside a masked
 * group, so the two fades share one mask; the 72 % lives on a View because the Svg's own width prop overrides its style.
 */
const TvDetailsBackdrop = ({ uri }: { uri: string }) => {
  const styles = useTvStyles(baseStyles);
  return (
    <View style={styles.backdrop} pointerEvents="none" testID="tv-details-backdrop">
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="tvDetailsFadeX" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#ffffff" stopOpacity={0} />
            <Stop offset="0.45" stopColor="#ffffff" stopOpacity={1} />
          </LinearGradient>
          <LinearGradient id="tvDetailsShadeY" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0" stopColor="#000000" stopOpacity={1} />
            <Stop offset="0.4" stopColor="#000000" stopOpacity={0} />
          </LinearGradient>
          <Mask id="tvDetailsMask" {...SVG_IMAGE_MASK_BOX}>
            <Rect x="0" y="0" width="100%" height="100%" fill="url(#tvDetailsFadeX)" />
            <Rect x="0" y="0" width="100%" height="100%" fill="url(#tvDetailsShadeY)" />
          </Mask>
        </Defs>
        <SvgImage
          href={{ uri }}
          x="0"
          y="0"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMin slice"
          opacity={0.3}
          mask="url(#tvDetailsMask)"
        />
      </Svg>
    </View>
  );
};

/**
 * TV title page (UX-TV-06, UX-TV-07, UX-TV-40, UX-TV-41; PLAT-TV-02), the approved mockup `tv-detail` (Chris 2026-11-12
 * (chat)): the top bar, "Back to …" under it, then the poster beside the version chips, a very large title, the meta line,
 * the buttons (one amber Play, Trailer when there is one, Playlist, and "…" for Delete), the genre pills and the synopsis.
 * Tabs below hold the rest: a movie Cast & crew, Versions, More like this; a show Episodes, Cast & crew, More like this. A
 * tab opens as soon as the highlight lands on it. Trailer plays the trailer full screen inside the app; Back returns to
 * the page. Play always starts the player the same way: the player asks "Resume at …" / "Start over" itself. The remote's
 * Back key closes an open panel or dialog first, then the page.
 */
export const TvMediaDetailsScreen = () => {
  const { t, i18n } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { mediaId } = useRoute().params as { mediaId: string };
  const { deleteMedia } = useLibraryActions();
  const { media } = useLibraryData();
  const { playlists, contains: playlistContains, toggle: togglePlaylist } = usePlaylistMembership(mediaId);
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  // The section this page was opened from, read once: its Back button names it and returns to it.
  const [backSection] = useState(currentTvSection);

  const { details, overview, loading, failed, retry, resumeEpisodeId, episodeResume, activeSeason, setActiveSeason } = useMediaDetailsState(
    mediaId,
    navigation,
    "tv",
  );
  const [tab, setTab] = useState<TvDetailsTab | null>(null);
  const [panelEpisodeId, setPanelEpisodeId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  // The playlist last switched keeps the focus while the list redraws with its new tick.
  const [playlistFocusKey, setPlaylistFocusKey] = useState<string | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [trailerKey, setTrailerKey] = useState<string | null>(null);
  const [trailerFailed, setTrailerFailed] = useState(false);
  const trailerButton = useRef<TvViewInstance | null>(null);
  // Focus targets of the D-pad wiring (UX-TV-06): DOWN from the buttons lands on the open tab, DOWN from the tabs on the
  // first item of the tab's content, UP from the content back on the open tab.
  const [selectedTabView, setSelectedTabView] = useState<TvViewInstance | null>(null);
  const [firstContentView, setFirstContentView] = useState<TvViewInstance | null>(null);
  const infoViews = useRef(new Map<string, TvViewInstance>());
  const closedPanelEpisodeId = useRef<string | null>(null);

  const backdrop = useMediaImage(details?.backdropPath ?? null, "backdrop");
  // Whether the title has a backdrop and whether its picture is on disk yet: tells "no data" from "not drawn".
  useEffect(() => {
    if (!details) return;
    console.info("tv.details.backdrop", JSON.stringify({ mediaId, hasPath: Boolean(details.backdropPath), loaded: backdrop !== null }));
  }, [backdrop, details, mediaId]);
  const episodeKeys = useMemo(() => uploadedEpisodeKeys(details), [details]);
  const seasonsWithFiles = useMemo(() => uploadedSeasonNumbers(episodeKeys), [episodeKeys]);
  const episodes = useMemo(
    () => (details?.episodes ?? []).filter((episode) => episode.seasonNumber === activeSeason),
    [activeSeason, details],
  );
  const genres = useMemo(
    () =>
      details
        ? details.genres.flatMap((id) => {
            const key = genreLabelKey(details.type, id);
            return key ? [{ id, label: t(key) }] : [];
          })
        : [],
    [details, t],
  );
  const nextEpisode = useMemo(() => playEpisode(details, resumeEpisodeId, episodeKeys), [details, episodeKeys, resumeEpisodeId]);
  const movieBlock = useMemo(() => (details?.type === "movie" ? movieMediaBlock(details) : null), [details]);
  const versionChips = useMemo(() => (details ? tvVersionChips(details, movieBlock) : []), [details, movieBlock]);
  const episodeBlocks = useMemo(() => episodeMediaBlocks(details), [details]);
  // UX-TV-06: Apple TV hands the trailer to the YouTube app, so without that app there is no Trailer button. Android TV
  // shows it as a QR code and never asks. Unknown until canOpenURL answers, so the button never appears and then vanishes.
  const [youtubeAppInstalled, setYoutubeAppInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    if (trailerShownAsQr()) return;
    let live = true;
    Linking.canOpenURL("youtube://")
      .catch(() => false)
      .then((installed) => {
        console.info("tv.details.trailer.youtubeApp", JSON.stringify({ installed }));
        if (live) setYoutubeAppInstalled(installed);
      });
    return () => {
      live = false;
    };
  }, []);
  const trailer = useMemo(
    () => (trailerShownAsQr() || youtubeAppInstalled === true ? youtubeTrailer(details?.trailers) : null),
    [details?.trailers, youtubeAppInstalled],
  );
  // LIB-CREW-01: the Cast & crew tab lists the director and writers first (role = their job), then the cast.
  const people = useMemo<MediaCastMember[]>(() => {
    if (!details) return [];
    const jobLabel = { director: t("details.crew.director"), writing: t("details.crew.writing") };
    const crew = crewPeople(details.crew).map((member) => ({
      id: `crew-${member.group}-${member.personId}`,
      personId: member.personId,
      tmdbId: member.tmdbId,
      name: member.name,
      role: jobLabel[member.group],
      profilePath: member.profilePath,
    }));
    return [...crew, ...details.cast];
  }, [details, t]);
  // UX-TV-40: More like this, from the library on this TV alone.
  const similar = useMemo(() => (details ? similarTitles(details, media) : []), [details, media]);
  const tabs = useMemo(
    () => (details ? tvDetailsTabs(details.type, people.length > 0, similar.length > 0) : []),
    [details, people, similar],
  );
  const activeTab: TvDetailsTab | null = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);

  // The player shows this artwork from its first moment, before its own session has loaded (PLAY-OPEN-01).
  const play = useCallback(
    (episodeId: string | null) => {
      const params = { mediaId, episodeId, backdropPath: details?.backdropPath ?? null, posterPath: details?.posterPath ?? null };
      console.info("tv.details.play", JSON.stringify({ mediaId, episodeId, backdrop: params.backdropPath !== null, poster: params.posterPath !== null }));
      navigation.navigate("Player", params);
    },
    [details?.backdropPath, details?.posterPath, mediaId, navigation],
  );
  const playEpisodeRow = useCallback((episodeId: string) => play(episodeId), [play]);

  // UX-TV-06: Android TV shows the trailer's YouTube page as a QR code for a phone. Apple TV has no WebView, so it hands
  // the trailer to the YouTube app.
  const openTrailer = useCallback(async () => {
    if (!trailer) return;
    setTrailerFailed(false);
    if (trailerShownAsQr()) {
      console.info("tv.details.trailer.press", JSON.stringify({ mediaId, key: trailer.key, via: "qr" }));
      setTrailerKey(trailer.key);
      return;
    }
    console.info("tv.details.trailer.open", JSON.stringify({ mediaId, key: trailer.key, via: "app" }));
    try {
      await Linking.openURL(trailer.appUrl);
    } catch (error) {
      console.warn("tv.details.trailer.failed", JSON.stringify({ mediaId, error: String(error) }));
      setTrailerFailed(true);
    }
  }, [mediaId, trailer]);
  // Closing the trailer gives the focus back to the Trailer button.
  const closeTrailer = useCallback(() => {
    setTrailerKey(null);
    console.info("tv.details.trailer.close", JSON.stringify({ mediaId, refocus: trailerButton.current !== null }));
    trailerButton.current?.requestTVFocus?.();
  }, [mediaId]);

  // Another tab of the top bar: the shell under this page switches to it, then the page closes onto it.
  const openSection = useCallback(
    (section: TvSectionId) => {
      console.info("tv.details.section", JSON.stringify({ from: backSection, to: section }));
      if (section !== backSection) requestTvSection(section);
      navigation.goBack();
    },
    [backSection, navigation],
  );

  const focusTab = useCallback((next: TvDetailsTab) => {
    setTab((current) => {
      if (current !== next) console.info("tv.details.tab", JSON.stringify({ tab: next }));
      return next;
    });
  }, []);

  // A season opens as soon as the highlight lands on it (UX-TV-08), so this runs on every focus: log real changes only.
  const selectSeason = useCallback(
    (seasonNumber: number) => {
      setActiveSeason((current) => {
        if (current !== seasonNumber) {
          console.info("tv.details.season", JSON.stringify({ seasonNumber, hasFiles: seasonsWithFiles.has(seasonNumber) }));
        }
        return seasonNumber;
      });
    },
    [seasonsWithFiles],
  );

  const registerInfo = useCallback((episodeId: string, view: TvViewInstance | null) => {
    if (view) infoViews.current.set(episodeId, view);
    else infoViews.current.delete(episodeId);
  }, []);
  const openPanel = useCallback((episodeId: string) => setPanelEpisodeId(episodeId), []);
  const closePanel = useCallback(() => {
    setPanelEpisodeId((current) => {
      closedPanelEpisodeId.current = current;
      return null;
    });
  }, []);
  // Closing the side panel gives the focus back to the ⓘ button that opened it.
  useEffect(() => {
    if (panelEpisodeId !== null) return;
    const episodeId = closedPanelEpisodeId.current;
    if (!episodeId) return;
    closedPanelEpisodeId.current = null;
    const view = infoViews.current.get(episodeId);
    console.info("tv.details.episodePanel.close", JSON.stringify({ episodeId, refocus: view !== undefined }));
    view?.requestTVFocus?.();
  }, [panelEpisodeId]);

  const confirmDelete = useCallback(async () => {
    try {
      await deleteMedia(mediaId);
      console.info("tv.details.deleted", JSON.stringify({ mediaId }));
      navigation.goBack();
    } catch (error) {
      console.warn("tv.details.deleteFailed", String(error));
      setConfirmingDelete(false);
      setDeleteFailed(true);
    }
  }, [deleteMedia, mediaId, navigation]);

  const moreItems = useMemo<TvListDialogItem[]>(
    () => [
      {
        key: "delete",
        label: t("tvShell.details.delete"),
        danger: true,
        testID: "tv-details-delete",
        onPress: () => {
          setMoreOpen(false);
          setDeleteFailed(false);
          setConfirmingDelete(true);
        },
      },
    ],
    [t],
  );
  const confirmItems = useMemo<TvListDialogItem[]>(
    () => [
      { key: "cancel", label: t("tvShell.details.cancel"), testID: "tv-details-delete-cancel", onPress: () => setConfirmingDelete(false) },
      {
        key: "confirm",
        label: t("tvShell.details.deleteConfirm"),
        danger: true,
        testID: "tv-details-delete-confirm",
        onPress: () => void confirmDelete(),
      },
    ],
    [confirmDelete, t],
  );

  // UX-TV-41: Playlist lists every playlist of the profile, Favorites and Watchlist included; OK adds the title to one or
  // takes it out, and the list stays open so several can be switched in a row.
  const playlistItems = useMemo<TvListDialogItem[]>(
    () =>
      playlists.map((playlist) => ({
        key: playlist.id,
        label: playlist.name,
        selected: Boolean(playlistContains[playlist.id]),
        testID: `tv-details-playlist-${playlist.id}`,
        onPress: () => {
          setPlaylistFocusKey(playlist.id);
          void togglePlaylist(playlist.id).catch((error: unknown) =>
            console.warn("tv.details.playlist.failed", JSON.stringify({ mediaId, playlistId: playlist.id, error: String(error) })),
          );
        },
      })),
    [mediaId, playlistContains, playlists, togglePlaylist],
  );
  const openPlaylists = useCallback(() => {
    console.info("tv.details.playlist.open", JSON.stringify({ mediaId, playlists: playlists.length }));
    setPlaylistFocusKey(undefined);
    setPlaylistOpen(true);
  }, [mediaId, playlists.length]);
  const openSimilar = useCallback(
    (id: string) => {
      console.info("tv.details.similar.open", JSON.stringify({ from: mediaId, mediaId: id }));
      navigation.push("MediaDetails", { mediaId: id });
    },
    [mediaId, navigation],
  );

  const tabsDestinations = useMemo(() => focusDestination(selectedTabView), [selectedTabView]);
  const contentDestinations = useMemo(() => focusDestination(firstContentView), [firstContentView]);
  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.accent} size="large" />
      </View>
    );
  }
  if (!details) {
    // `failed`: the read threw or found nothing. Say so and offer Retry rather than a dead page.
    return (
      <View style={styles.centered} testID={failed ? "tv-details-failed" : undefined}>
        <Text style={styles.body}>{t("player.error.loadFailed")}</Text>
        <TvPillButton
          variant="primary"
          icon={RotateCw}
          label={t("player.error.retry")}
          style={styles.retry}
          hasTVPreferredFocus
          onPress={retry}
          testID="tv-details-retry"
        />
      </View>
    );
  }

  const show = details.type === "tv";
  const canPlay = !show || nextEpisode !== null;
  const nextResume = nextEpisode ? episodeResume[nextEpisode.id] : undefined;
  const playLabel = nextEpisode
    ? t(isEpisodeResumable(nextResume) ? "details.resumeEpisode" : "details.playEpisode", {
        code: formatEpisodeCode(nextEpisode.seasonNumber, nextEpisode.episodeNumber),
      })
    : t("details.play");

  // UX-TV-06: the year, then a movie's length or a show's seasons, the TMDB rating, and the original language.
  const runtime = show ? null : runtimeParts(movieBlock?.durationSeconds ?? null);
  const seasonCount = details.seasons.filter((season) => season.seasonNumber > 0).length;
  const languageCode = details.originalLanguage?.toLowerCase() ?? null;
  const meta = [
    details.year,
    show
      ? seasonCount > 0
        ? t("details.runtime.seasons", { count: seasonCount })
        : null
      : runtime
        ? runtime.hours > 0
          ? t("tvShell.details.runtimeHours", runtime)
          : t("tvShell.details.runtimeMinutes", { minutes: runtime.minutes })
        : null,
    typeof details.rating === "number" && details.rating > 0 ? formatStarRating(details.rating) : null,
    languageCode ? t(`languageNames.${languageCode}`, { defaultValue: languageCode.toUpperCase() }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Progress under the details: a movie's own, or the episode Play resumes.
  let progressPct = 0;
  let progressText: string | null = null;
  if (show) {
    if (nextEpisode && isEpisodeResumable(nextResume)) {
      progressPct = Math.round(nextResume?.progressPct ?? 0);
      progressText = `${t("tvShell.details.episodeCode", { season: nextEpisode.seasonNumber, episode: nextEpisode.episodeNumber })} · ${t(
        "details.watchedPercent",
        { percent: progressPct },
      )}`;
    }
  } else if (details.progressPct > 0 && details.progressPct < COMPLETED_PCT_THRESHOLD) {
    progressPct = Math.round(details.progressPct);
    const left = minutesLeft(details.progressPct, movieBlock?.durationSeconds ?? null);
    progressText =
      left !== null
        ? t("tvShell.details.watchedLeft", { percent: progressPct, count: left })
        : t("details.watchedPercent", { percent: progressPct });
  }

  const panelEpisode = panelEpisodeId ? (details.episodes.find((episode) => episode.id === panelEpisodeId) ?? null) : null;
  const panelBlock = panelEpisode ? (episodeBlocks.get(panelEpisode.id) ?? null) : null;
  const panelMinutes = panelBlock?.durationSeconds ? Math.max(1, Math.round(panelBlock.durationSeconds / 60)) : null;
  const panelAired = panelEpisode ? formatDate(panelEpisode.airDate, i18n.language) : null;
  const panelMeta = [
    panelMinutes !== null ? t("tvShell.details.runtimeMinutes", { minutes: panelMinutes }) : null,
    panelAired ? t("tvShell.details.aired", { date: panelAired }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={styles.screen}>
      {backdrop ? <TvDetailsBackdrop uri={backdrop} /> : null}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* The shell's top bar, its tab the section the page was opened from: another tab goes back and opens that section. */}
        <TvTopBar active={backSection} onSelect={openSection} />
        {/* An on-screen way back to the section the page was opened from (UX-TV-06), besides the remote's Back key.
            Full width, so UP from Play (which is not straight below it) lands on it. */}
        <TVFocusGuideView autoFocus style={styles.backRow}>
          <TvFocusable
            style={styles.crumb}
            onPress={() => {
              console.info("tv.details.back", JSON.stringify({ to: backSection }));
              navigation.goBack();
            }}
            testID="tv-details-back"
            accessibilityLabel={t(tvBackLabelKey(backSection))}
          >
            <ChevronLeft size={12 * scale} color={TV_COLOR.muted} />
            <Text style={styles.crumbLabel}>{t(tvBackLabelKey(backSection))}</Text>
          </TvFocusable>
        </TVFocusGuideView>
        {/* tvOS moves the focus only to what lies in the pressed direction: the whole top is a focus guide that hands a move
            into it to its last focused button, Play at first (TV-DETAILS-FOCUS-001). */}
        <TVFocusGuideView autoFocus style={styles.main}>
          <View style={styles.poster}>
            <MediaArtwork path={details?.posterPath ?? null} kind="poster" style={styles.fill} label={details?.title} />
          </View>
          <View style={styles.info}>
            {versionChips.length > 0 ? (
              <View style={styles.chips} testID="tv-details-versions-chips">
                {versionChips.map((chip) => (
                  <View key={chip.key} style={[styles.chip, chip.playing && styles.chipPlaying]} testID={`tv-details-chip-${chip.key}`}>
                    <Text style={[styles.chipLabel, chip.playing && styles.chipLabelPlaying]} numberOfLines={1}>
                      {chip.label}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Text style={[styles.title, versionChips.length > 0 && styles.titleUnderChips]} accessibilityRole="header" numberOfLines={2}>
              {details.title}
            </Text>
            {meta ? (
              <Text style={styles.meta} numberOfLines={1} testID="tv-details-meta">
                {meta}
              </Text>
            ) : null}
            {progressText ? (
              <View style={styles.watched} testID="tv-details-progress">
                <View style={styles.track}>
                  <View style={[styles.trackFill, { width: `${progressPct}%` }]} />
                </View>
                <Text style={styles.watchedText}>{progressText}</Text>
              </View>
            ) : null}
            {deleteFailed ? <Text style={styles.error}>{t("tvShell.details.deleteFailed")}</Text> : null}
            {trailerFailed ? <Text style={styles.error}>{t("tvShell.details.trailerFailed")}</Text> : null}
            <View style={styles.actions}>
              {canPlay ? (
                <TvPillButton
                  variant="primary"
                  icon={Play}
                  filledIcon
                  label={playLabel}
                  hasTVPreferredFocus
                  onPress={() => play(show ? (nextEpisode?.id ?? null) : null)}
                  testID="tv-details-play"
                />
              ) : null}
              {trailer ? (
                <TvPillButton
                  ref={trailerButton}
                  icon={Clapperboard}
                  label={t("tvShell.details.trailer")}
                  hasTVPreferredFocus={!canPlay}
                  onPress={() => void openTrailer()}
                  testID="tv-details-trailer"
                />
              ) : null}
              <TvPillButton
                icon={ListPlus}
                label={t("tvShell.details.playlist")}
                hasTVPreferredFocus={!canPlay && !trailer}
                onPress={openPlaylists}
                testID="tv-details-playlist"
              />
              {/* Delete stays one press away behind "…" (PLAT-TV-02, UX-TV-41). */}
              <TvIconButton
                icon={Ellipsis}
                style={styles.more}
                onPress={() => setMoreOpen(true)}
                testID="tv-details-more"
                accessibilityLabel={t("tvShell.details.more")}
              />
            </View>
            {genres.length > 0 ? (
              <View style={styles.genres} testID="tv-details-genres">
                {genres.map((genre) => (
                  <View key={genre.id} style={styles.genre} testID={`tv-details-genre-${genre.id}`}>
                    <Tag size={10 * scale} color={TV_COLOR.amber} />
                    <Text style={styles.genreLabel} numberOfLines={1}>
                      {genre.label}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            {overview ? (
              <Text style={styles.overview} numberOfLines={3} testID="tv-details-overview">
                {overview}
              </Text>
            ) : null}
          </View>
        </TVFocusGuideView>

        {/* DOWN from the buttons and UP from the content land on the open tab. */}
        <TVFocusGuideView style={styles.tabs} destinations={tabsDestinations}>
          {tabs.map((id) => {
            const selected = id === activeTab;
            return (
              <TvFocusable
                key={id}
                ref={selected ? setSelectedTabView : undefined}
                style={[styles.tab, selected && styles.tabSelected]}
                scale={1}
                onFocus={() => focusTab(id)}
                onPress={() => focusTab(id)}
                accessibilityState={{ selected }}
                accessibilityLabel={t(TAB_LABEL_KEYS[id])}
                testID={`tv-details-tab-${id}`}
              >
                <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>{t(TAB_LABEL_KEYS[id])}</Text>
              </TvFocusable>
            );
          })}
        </TVFocusGuideView>

        {/* DOWN from the tabs lands on the first item of the open tab. */}
        <TVFocusGuideView style={styles.tabBody} destinations={contentDestinations} testID={`tv-details-tabbody-${activeTab}`}>
          {activeTab === "episodes" ? (
            <TvDetailsEpisodes
              seasons={details.seasons}
              seasonsWithFiles={seasonsWithFiles}
              activeSeason={activeSeason}
              onSeason={selectSeason}
              episodes={episodes}
              episodeKeys={episodeKeys}
              resume={episodeResume}
              blocks={episodeBlocks}
              onPlay={playEpisodeRow}
              onInfo={openPanel}
              registerInfo={registerInfo}
              firstRef={setFirstContentView}
            />
          ) : activeTab === "versions" ? (
            <TvFocusable ref={setFirstContentView} scale={1} ring="inside" style={styles.versions} testID="tv-details-versions">
              <TvMediaTracksBlock block={movieBlock} />
            </TvFocusable>
          ) : activeTab === "cast" ? (
            <TvDetailsCast cast={people} firstRef={setFirstContentView} />
          ) : activeTab === "similar" ? (
            // A poster card hands no ref out: this guide takes DOWN from the tabs to the first card instead.
            <TVFocusGuideView autoFocus>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.similar} testID="tv-details-similar">
                {similar.map((item) => (
                  <TvPosterCard key={item.id} item={item} width={SIMILAR_CARD_WIDTH} onPress={openSimilar} showProgress />
                ))}
              </ScrollView>
            </TVFocusGuideView>
          ) : null}
        </TVFocusGuideView>
      </ScrollView>

      {panelEpisode ? (
        <TvEpisodePanel
          episode={panelEpisode}
          block={panelBlock}
          metaText={panelMeta || null}
          resumable={isEpisodeResumable(episodeResume[panelEpisode.id])}
          hasFile={episodeKeys.has(episodeFileKey(panelEpisode.seasonNumber, panelEpisode.episodeNumber))}
          onPlay={playEpisodeRow}
          onClose={closePanel}
        />
      ) : null}
      {trailerKey ? <TvTrailerQr mediaId={mediaId} videoKey={trailerKey} onClose={closeTrailer} /> : null}
      {playlistOpen ? (
        <TvListDialog
          title={t("tvShell.details.playlistTitle")}
          message={playlists.length === 0 ? t("tvShell.details.playlistEmpty") : undefined}
          items={playlistItems}
          initialFocusKey={playlistFocusKey}
          onClose={() => setPlaylistOpen(false)}
          testID="tv-details-playlist-dialog"
        />
      ) : null}
      {moreOpen ? (
        <TvListDialog title={details.title} items={moreItems} onClose={() => setMoreOpen(false)} testID="tv-details-more-dialog" />
      ) : null}
      {confirmingDelete ? (
        <TvListDialog
          title={t("tvShell.details.deleteConfirmTitle", { title: details.title })}
          message={t("tvShell.details.deleteConfirmBody")}
          items={confirmItems}
          initialFocusKey="cancel"
          onClose={() => setConfirmingDelete(false)}
          testID="tv-details-delete-dialog"
        />
      ) : null}
    </View>
  );
};

/** Sizes in design dp: the mockup's px halved (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingBottom: 24 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  retry: { marginTop: 20 },
  backdrop: { position: "absolute", top: 0, right: 0, bottom: 0, width: "72%", height: "100%" },
  fill: { width: "100%", height: "100%" },
  backRow: { flexDirection: "row", marginTop: 8, paddingHorizontal: TV_SPACE.screenX - 9 },
  crumb: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 5, paddingHorizontal: 9, borderRadius: TV_RADII.control },
  crumbLabel: { fontFamily: TV_FONT.body, fontSize: 10.5, fontWeight: "700", color: TV_COLOR.muted },
  main: { flexDirection: "row", gap: 30, paddingTop: 8, paddingHorizontal: TV_SPACE.screenX },
  poster: {
    width: TV_DETAILS_POSTER_WIDTH,
    height: TV_DETAILS_POSTER_WIDTH * 1.5,
    borderRadius: 7,
    overflow: "hidden",
    backgroundColor: TV_COLOR.card,
    boxShadow: "0px 15px 35px rgba(0, 0, 0, 0.6)",
  },
  info: { flex: 1, paddingTop: 3 },
  chips: { flexDirection: "row", gap: 6 },
  chip: {
    height: 20,
    paddingHorizontal: 8,
    borderRadius: 5,
    justifyContent: "center",
    backgroundColor: "rgba(36, 38, 56, 0.9)",
    borderWidth: 0.5,
    borderColor: "rgba(68, 71, 90, 0.8)",
  },
  chipPlaying: { borderColor: "rgba(255, 179, 87, 0.8)" },
  chipLabel: { fontFamily: TV_FONT.body, fontSize: 9, fontWeight: "700", color: TV_COLOR.text },
  chipLabelPlaying: { color: TV_COLOR.amber },
  title: { fontFamily: TV_FONT.display, fontSize: 52, lineHeight: 54, fontWeight: "700", letterSpacing: -1, color: TV_COLOR.text },
  titleUnderChips: { marginTop: 9 },
  meta: { marginTop: 9, fontFamily: TV_FONT.body, fontSize: 12.5, color: TV_COLOR.muted },
  watched: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 9 },
  track: { width: 140, height: 4, borderRadius: TV_RADII.pill, overflow: "hidden", backgroundColor: TV_COLOR.border },
  trackFill: { height: "100%", backgroundColor: TV_COLOR.amber },
  watchedText: { fontFamily: TV_FONT.body, fontSize: 10.5, color: TV_COLOR.muted },
  body: { fontFamily: TV_FONT.body, fontSize: 12.5, color: TV_COLOR.muted },
  error: { marginTop: 8, fontFamily: TV_FONT.body, fontSize: 11, color: TV_COLOR.danger },
  actions: { flexDirection: "row", alignItems: "center", gap: 11, marginTop: 18 },
  more: { borderRadius: TV_RADII.pill },
  genres: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 15 },
  genre: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 22,
    paddingHorizontal: 9,
    borderRadius: TV_RADII.pill,
    backgroundColor: "rgba(36, 38, 56, 0.85)",
    borderWidth: 0.5,
    borderColor: "rgba(68, 71, 90, 0.7)",
  },
  genreLabel: { fontFamily: TV_FONT.body, fontSize: 9.5, fontWeight: "600", color: TV_COLOR.text },
  overview: { marginTop: 13, maxWidth: 530, fontFamily: TV_FONT.body, fontSize: 12, lineHeight: 18, color: "rgba(222, 226, 242, 0.88)" },
  tabs: {
    flexDirection: "row",
    gap: 4,
    marginTop: 20,
    marginHorizontal: TV_SPACE.screenX,
    borderBottomWidth: 0.75,
    borderBottomColor: "rgba(68, 71, 90, 0.55)",
  },
  tab: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 0, borderBottomWidth: 2, borderBottomColor: "transparent", marginBottom: -0.75 },
  tabSelected: { borderBottomColor: TV_COLOR.amber },
  tabLabel: { fontFamily: TV_FONT.body, fontSize: 11.5, fontWeight: "700", color: TV_COLOR.muted },
  tabLabelSelected: { color: TV_COLOR.text },
  tabBody: { paddingTop: 15, paddingHorizontal: TV_SPACE.screenX, minHeight: 120 },
  versions: { borderRadius: TV_RADII.card },
  similar: { gap: TV_SPACE.posterGap, paddingVertical: 6 },
});
