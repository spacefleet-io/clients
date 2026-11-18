import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLocalizedOverview } from "@space/metadata-client/react";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { defaultSeason } from "./defaultSeason";
import { libraryRevision } from "./libraryRevision";
import { scopeLogger } from "@space/mobile-shell/logger";
import { playEpisode, uploadedEpisodeKeys, uploadedSeasonNumbers } from "./playback/episodeSelection";
import { warmPlayStart } from "./playback/playStartWarm";
import type { EpisodeResume } from "@space/shared/playbackResume";
import { fetchOverview } from "./metadata/runtime";
import { useLocalizedShowDetails } from "./useLocalizedShowDetails";
import { getLastPlayedEpisodeId } from "./resume";
import { useAuth } from "../store/auth";
import { useLibraryActions, useLibraryStatus } from "../store/library";

const log = scopeLogger("details");

/** The screen's navigation, reduced to what the hook listens to: the page regaining focus (the player popped). */
type FocusSource = { addListener: (event: "focus", listener: () => void) => () => void };

export type MediaDetailsState = {
  /** The title as stored, except a show's episode names and synopses: in the interface language, else English, else
   * the stored ones (LIB-LANG-01). */
  details: MediaDetails | null;
  /** The synopsis in the interface language, else English, else the stored one (LIB-LANG-01). */
  overview: string | null;
  loading: boolean;
  /** The read threw or found nothing: the page shows "could not load" with Retry, never a blank sheet. */
  failed: boolean;
  retry: () => void;
  /** Play's target on a show: the last-played episode, refreshed when the player hands the page back. */
  resumeEpisodeId: string | null;
  /** Per-episode progress (desktop `episode_resume_v1`), refreshed the same way. */
  episodeResume: Record<string, EpisodeResume>;
  activeSeason: number;
  setActiveSeason: Dispatch<SetStateAction<number>>;
};

/**
 * The details page's data for the phone sheet and the TV page: the title, Play's target and the progress per episode.
 * Read once on open (the last-played episode and the progress start with the details read, #934), and again each time
 * the page regains focus after the library changed (#957): coming back from the player, Play must offer the episode
 * just watched and the progress must be the new one (TV-DETAILS-RESUME-001). A failed read is `failed`, with `retry`.
 */
export const useMediaDetailsState = (mediaId: string, navigation: FocusSource, surface: "phone" | "tv"): MediaDetailsState => {
  const { token } = useAuth();
  const { getMediaDetails, getEpisodeResumeMap, getTrackPrefs } = useLibraryActions();
  const { awaitDatasetReady, datasetStatus } = useLibraryStatus();

  const [details, setDetails] = useState<MediaDetails | null>(null);
  const { i18n } = useTranslation();
  const overview = useLocalizedOverview(details, i18n.language, token ? fetchOverview : null);
  const shownDetails = useLocalizedShowDetails(details);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [resumeEpisodeId, setResumeEpisodeId] = useState<string | null>(null);
  const [episodeResume, setEpisodeResume] = useState<Record<string, EpisodeResume>>({});
  const [activeSeason, setActiveSeason] = useState(1);

  // The library revision of the last read: a focus with no library change since reads nothing.
  const readRevision = useRef(-1);
  const unchangedSinceRead = useCallback(() => {
    const revision = libraryRevision();
    if (revision === readRevision.current) {
      log.debug("focus.unchanged", { surface, mediaId, revision });
      return true;
    }
    readRevision.current = revision;
    return false;
  }, [mediaId, surface]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      setLoading(true);
      setFailed(false);
      try {
        if (!datasetStatus.metadata) await awaitDatasetReady("metadata");
        readRevision.current = libraryRevision();
        const [data, savedEpisodeId, resumeMap] = await Promise.all([
          getMediaDetails(mediaId, { chunks: false }),
          getLastPlayedEpisodeId(mediaId),
          getEpisodeResumeMap(mediaId).catch(() => null),
        ]);
        if (!mounted) return;
        setDetails(data);
        setFailed(data === null);
        if (data?.type === "tv") {
          const resumeEpisode = data.episodes.find((episode) => episode.id === savedEpisodeId) ?? null;
          if (resumeMap) setEpisodeResume(resumeMap);
          setResumeEpisodeId(resumeEpisode?.id ?? null);
          const withFiles = uploadedSeasonNumbers(uploadedEpisodeKeys(data));
          const season = defaultSeason(
            data.seasons.map((item) => item.seasonNumber),
            resumeEpisode?.seasonNumber ?? null,
            withFiles,
          );
          log.info("default_season", { surface, mediaId, season, resumeSeason: resumeEpisode?.seasonNumber ?? null, seasonsWithFiles: [...withFiles] });
          setActiveSeason(season);
        }
        if (data) {
          const playTarget = playEpisode(data, savedEpisodeId, uploadedEpisodeKeys(data));
          warmPlayStart({ token, mediaId, details: data, episodeId: playTarget?.id ?? null, readTrackPrefs: getTrackPrefs });
        }
        log.info("loaded", {
          surface,
          mediaId,
          attempt,
          found: data !== null,
          type: data?.type ?? null,
          files: data?.files.length ?? 0,
          formats: data?.formats.length ?? 0,
          trailers: data?.trailers?.length ?? 0,
          cast: data?.cast.length ?? 0,
        });
      } catch (error) {
        if (!mounted) return;
        log.error("load.failed", { surface, mediaId, attempt, error: error instanceof Error ? error.message : String(error) });
        setDetails(null);
        setFailed(true);
      }
      if (mounted) setLoading(false);
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [attempt, awaitDatasetReady, datasetStatus.metadata, getEpisodeResumeMap, getMediaDetails, getTrackPrefs, mediaId, surface, token]);

  const isShow = details?.type === "tv";
  const isMovie = details?.type === "movie";
  useEffect(() => {
    if (!isShow && !isMovie) return undefined;
    let cancelled = false;
    const unsubscribe = navigation.addListener("focus", () => {
      if (unchangedSinceRead()) return;
      if (isShow) {
        void Promise.all([getEpisodeResumeMap(mediaId), getLastPlayedEpisodeId(mediaId)])
          .then(([map, lastPlayedEpisodeId]) => {
            if (cancelled) return;
            log.info("refreshed", { surface, mediaId, type: "tv", lastPlayedEpisodeId, episodes: Object.keys(map).length });
            setEpisodeResume(map);
            setResumeEpisodeId(lastPlayedEpisodeId);
          })
          .catch((error) => log.warn("refresh.failed", { surface, mediaId, error: String(error) }));
        return;
      }
      // A movie's progress lives on the title itself: read it again.
      void getMediaDetails(mediaId, { chunks: false })
        .then((data) => {
          if (cancelled || !data) return;
          log.info("refreshed", { surface, mediaId, type: "movie", progressPct: data.progressPct });
          setDetails(data);
        })
        .catch((error) => log.warn("refresh.failed", { surface, mediaId, error: String(error) }));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [getEpisodeResumeMap, getMediaDetails, isMovie, isShow, mediaId, navigation, surface, unchangedSinceRead]);

  const retry = useCallback(() => {
    log.info("retry", { surface, mediaId });
    setAttempt((n) => n + 1);
  }, [mediaId, surface]);

  return { details: shownDetails, overview, loading, failed, retry, resumeEpisodeId, episodeResume, activeSeason, setActiveSeason };
};
