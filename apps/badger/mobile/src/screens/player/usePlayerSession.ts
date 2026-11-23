import { useCallback, useEffect, useRef, useState } from "react";
import { findMediaPlacementId } from "@space/shared/mediaPlacement";
import { trackBelongsToPlayingFile, type MediaDetails, type MediaEpisode } from "@space/shared/libraryTypes";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import type { TrackPrefs } from "@space/shared/trackPrefs";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import { PlaybackBridge, type IngestMetadata, type StartProxyConfig } from "@space/mobile-mpv-playback";
import { translate } from "@space/mobile-shell/i18n";
import { useAuth } from "../../store/auth";
import { useLibraryActions, useLibraryStatus } from "../../store/library";
import { useLoadingModal } from "../../components/LoadingModalProvider";
import { setLastPlayedEpisodeId } from "../../lib/resume";
import { gatewayCandidatesForPlay, libraryKeyForPlay, takeWarmTrackPrefs } from "../../lib/playback/playStartWarm";
import { fetchSiloTraffic } from "../../lib/playback/siloTraffic";
import { chaptersForFile } from "../../lib/playback/fileChapters";
import { previewSheetsForFile, watchLatePreviewSheets } from "../../lib/playback/seekPreviewSource";
import { syncedLibraryRevision } from "../../lib/libraryRevision";
import { filterToDownloadedFormat, resolveOfflinePlayback } from "../../lib/downloads/offlinePlayback";
import { buildIngestMetadata } from "../../lib/playback/ingestMetadata";
import { selectMarkersForPlayback } from "../../lib/playback/nextEpisode";
import { getNextPlayableEpisode, getPreviousPlayableEpisode } from "@space/shared/playableEpisodes";
import { resolveResumeCandidateSeconds } from "@space/shared/playbackResume";
import type { SkipMarkerLike } from "../../lib/playback/skipMarkers";
import { getViewingScope } from "../../lib/profiles/activeViewingScope";
import { acquireStream, onStreamTakenOver, streamSlots } from "../../lib/playback/streamSlot";
import { noteHelloPlay } from "@space/shared/dailyHello";

const APP_ID = "badger";

/** Bumped per startProxy call so a late-resolving start never stops a newer session's proxy. */
let proxyGeneration = 0;

/** Why the session could not load: the suffix of the `player.error.<code>` i18n key. */
export type PlayerErrorCode =
  | "missingLibraryKey"
  | "titleMissing"
  | "noPlayableFile"
  | "notAvailable"
  | "gatewayUnavailable"
  | "startFailed"
  | "loadFailed";

export type PlayerSession = {
  phase: "loading" | "ready" | "error";
  /** Failure code; the screen shows `player.error.<code>` in the current language. */
  error: PlayerErrorCode | null;
  /** Re-run the whole load (proxy + metadata) after an error or a playback failure. */
  reload: () => void;
  playUrl: string | null;
  metadata: IngestMetadata | null;
  details: MediaDetails | null;
  episode: MediaEpisode | null;
  nextEpisode: MediaEpisode | null;
  /** The playable episode before this one (PLAY-OVL-03): the centre previous-episode button shows only when set. */
  previousEpisode: MediaEpisode | null;
  markers: SkipMarkerLike[];
  durationSeconds: number;
  /** Seconds to offer "Resume at" for, or null (nothing to resume / completed / trivial). */
  resumeCandidateSeconds: number | null;
  /** The title's remembered audio + subtitle choice (PLAY-TRACK-04), or null; the player applies it at start. */
  trackPrefs: TrackPrefs | null;
  /** Reads the played media's silo traffic report (STOR-BW-07, PLAY-QUAL-07); null when the file plays from disk. */
  fetchTraffic: (() => Promise<StorageTraffic | null>) | null;
  /** True when the file plays from a download on disk (no gateway involved). */
  offline: boolean;
  /** The played file's seek-bar preview sheets (MPV-PREV-01), or null: the seek bar then behaves as before. */
  previews: MediaPreviewSheets | null;
  /**
   * The account's stream limit closed this playback (ACCT-STREAM-02): `cancelled` = the user chose Cancel at "Play
   * here instead?"; `takenOver` = another device took the place. The screen closes; the alert says why.
   */
  closeReason: "cancelled" | "takenOver" | null;
};

const IDLE: Omit<PlayerSession, "reload"> = {
  phase: "loading",
  error: null,
  playUrl: null,
  metadata: null,
  details: null,
  episode: null,
  nextEpisode: null,
  previousEpisode: null,
  markers: [],
  durationSeconds: 0,
  resumeCandidateSeconds: null,
  trackPrefs: null,
  fetchTraffic: null,
  offline: false,
  previews: null,
  closeReason: null,
};

/**
 * Loads everything the player needs for one (media, episode): details, ingest metadata, the
 * native HLS proxy URL, skip markers, next episode and the resume candidate. Owns proxy start/stop.
 */
export const usePlayerSession = (mediaId: string, episodeId: string | null): PlayerSession => {
  const { token } = useAuth();
  const { getMediaDetails, getPlaybackChunks, getPlayableTrackIds, getEpisodeResumeMap, getTrackPrefs } = useLibraryActions();
  const { awaitDatasetReady, datasetStatus } = useLibraryStatus();
  const { showLoading, hideLoading } = useLoadingModal();
  // The load effect must NOT depend on these: a library sync flips `datasetStatus` and re-creates
  // the callbacks mid-playback, which would tear the session down and reload it from the stale
  // resume point. It reads the latest values through this ref instead.
  const liveRef = useRef({ token, getMediaDetails, getPlaybackChunks, getPlayableTrackIds, getEpisodeResumeMap, getTrackPrefs, awaitDatasetReady, datasetStatus, showLoading, hideLoading });
  liveRef.current = { token, getMediaDetails, getPlaybackChunks, getPlayableTrackIds, getEpisodeResumeMap, getTrackPrefs, awaitDatasetReady, datasetStatus, showLoading, hideLoading };
  const live = () => liveRef.current;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<PlayerSession, "reload">>(IDLE);
  const proxyStarted = useRef(false);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // ACCT-STREAM-02/04: the place is held across reloads and episodes, given back when the player closes, and a
  // takeover by another device closes the player.
  useEffect(() => {
    const stopListening = onStreamTakenOver(() => setState((current) => ({ ...current, closeReason: "takenOver" })));
    return () => {
      stopListening();
      void streamSlots.release("player");
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let tokenRef: string | null = null;
    // Set once the file is known to play from a download, so a later failure still says so (ACCT-UNPAID-03).
    let playsFromDisk = false;
    // MPV-PREV-04: stops the watch for previews recorded while this playback is open.
    let stopLatePreviews: (() => void) | null = null;

    const fail = (code: PlayerErrorCode) => {
      if (!mounted) return;
      setState({ ...IDLE, phase: "error", error: code, offline: playsFromDisk });
      if (tokenRef) live().hideLoading(tokenRef);
    };

    const load = async () => {
      const token = live().token;
      if (!token) return;
      console.warn("playback.load.start", JSON.stringify({ mediaId, episodeId, attempt }));
      setState(IDLE);

      // These reads need only the media id, so they start together instead of one after another (#934): the
      // library key (Keychain), the playback dataset wait and, once it is ready, the resume map and track prefs.
      // A read the details page already started (playStartWarm) is joined, not repeated. Each is awaited at
      // the point the serial chain awaited it, so failures surface in the same order with the same codes.
      const libraryKeyRead = libraryKeyForPlay().catch(() => null);
      const datasetReady = live().awaitDatasetReady("playback");
      const resumeMapRead = episodeId
        ? datasetReady.then(() => live().getEpisodeResumeMap(mediaId)).catch(() => null)
        : Promise.resolve(null);
      // Keyed by the movie / SHOW id (the route's mediaId), never the episode id, so the next episode inherits it.
      const trackPrefsRead = (takeWarmTrackPrefs(mediaId) ?? datasetReady.then(() => live().getTrackPrefs(mediaId))).catch(
        () => null,
      );

      const libraryKeyBase64 = await libraryKeyRead;
      if (!libraryKeyBase64) return fail("missingLibraryKey");

      if (!live().datasetStatus.playback) {
        tokenRef = live().showLoading({ title: translate("player.loading") });
      }
      await datasetReady;

      // Segment rows are loaded below for the one file being played, not here for every episode of the title.
      // Revision first: a record landing during the read below is read again by the late-previews watch (MPV-PREV-04).
      const detailsRevision = syncedLibraryRevision();
      const [details, tracksWithChunks] = await Promise.all([
        live().getMediaDetails(mediaId, { chunks: false }),
        live().getPlayableTrackIds(mediaId),
      ]);
      if (!mounted) return;
      if (!details) return fail("titleMissing");
      const episode = episodeId ? details.episodes.find((item) => item.id === episodeId) ?? null : null;
      const file =
        details.type === "movie"
          ? details.files[0] ?? null
          : episode
          ? details.files.find(
              (item) => item.season === episode.seasonNumber && item.episode === episode.episodeNumber,
            ) ?? null
          : details.files[0] ?? null;
      if (details.type === "tv") {
        void setLastPlayedEpisodeId(mediaId, episode?.id ?? null);
      }
      if (!file) return fail("noPlayableFile");

      // Per-media silo placement (#145): the played media's keys name the silo that serves them; legacy keys fall
      // back to the first active shard. The lookup starts now, next to the offline check and the segment read, and
      // its answer is dropped when the file plays from disk. STOR-BW-11: with no active profile resolved nothing
      // streams, so nothing is asked of the gateway either.
      const profileId = getViewingScope().profileId;
      const placementId = findMediaPlacementId(details, episode?.id ?? null);
      const gatewayLookup: Promise<{ urls: string[] } | { error: unknown }> | null = profileId
        ? gatewayCandidatesForPlay(token, placementId).then(
            (urls) => ({ urls }),
            (error: unknown) => ({ error }),
          )
        : null;

      const fileFormats = details.formats.filter((format) => format.fileId === file.id);
      const offline = await resolveOfflinePlayback(file.id).catch(() => null);
      const offlineFormats = offline ? filterToDownloadedFormat(fileFormats, offline) : [];
      const useOffline = offlineFormats.length > 0;
      playsFromDisk = useOffline;
      const formatsWithoutChunks = useOffline ? offlineFormats : fileFormats;
      const playingEpisodeId = episode?.id ?? null;
      const audioTracksWithoutChunks = details.audioTracks.filter((track) => trackBelongsToPlayingFile(track, file.id, playingEpisodeId));
      const subtitleTracks = details.subtitleTracks.filter((track) => trackBelongsToPlayingFile(track, file.id, playingEpisodeId));
      const chunks = await live().getPlaybackChunks(
        formatsWithoutChunks.map((format) => format.id),
        audioTracksWithoutChunks.map((track) => track.id),
      );
      if (!mounted) return;
      const formats = formatsWithoutChunks.map((format) => ({ ...format, chunks: chunks.formats[format.id] ?? [] }));
      const audioTracks = audioTracksWithoutChunks.map((track) => ({ ...track, chunks: chunks.audio[track.id] ?? [] }));

      // Chapters hang off a format but belong to the file: a downloaded lower-quality copy has no rows
      // of its own, so they come from any format of the same file (PLAY-CHAP-01).
      const fileChapters = chaptersForFile(details.chapters ?? [], formats, fileFormats);
      const fileDurationSeconds = formats[0]?.durationSeconds ?? 0;

      const ingestMeta = buildIngestMetadata({
        formats,
        audioTracks,
        subtitleTracks,
        chapters: fileChapters,
        durationSeconds: fileDurationSeconds,
      });
      if (ingestMeta.videos.length === 0) return fail("notAvailable");

      // A fully downloaded file needs no gateway: the proxy reads the encrypted objects from disk (works in airplane mode).
      let proxyConfig: StartProxyConfig;
      let fetchTraffic: PlayerSession["fetchTraffic"] = null;
      if (useOffline) {
        console.warn("playback.offline", JSON.stringify({ fileId: file.id, formatId: formats[0]?.id }));
        proxyConfig = { clientKind: "offline" };
      } else {
        // STOR-BW-11: every streaming request names the active profile (the main profile's real id too). None resolved
        // is a client bug: start nothing rather than guess one.
        if (!profileId || !gatewayLookup) {
          console.warn("playback.profile.missing", JSON.stringify({ mediaId, fileId: file.id }));
          return fail("startFailed");
        }
        const gateway = await gatewayLookup;
        if ("error" in gateway) {
          console.warn("playback.gateway.resolve_failed", JSON.stringify({ placementId, error: String(gateway.error) }));
          return fail("gatewayUnavailable");
        }
        const gatewayBaseUrls = gateway.urls;
        console.warn("playback.profile.attached", JSON.stringify({ profileId, placementId }));
        proxyConfig = { clientKind: "storage-tunnel", gatewayBaseUrls, authToken: token, appId: APP_ID, profileId };
        fetchTraffic = () => fetchSiloTraffic(gatewayBaseUrls, token, profileId);
      }

      // ACCT-STREAM-01..03: a streamed file takes one of the profile's places first; a download on disk never asks.
      const slotAnswer = await acquireStream({ token, kind: "play", owner: "player", offline: useOffline });
      if (!mounted) return;
      if (slotAnswer === "cancel") {
        console.warn("playback.stream_slot.cancelled", JSON.stringify({ mediaId, fileId: file.id }));
        setState({ ...IDLE, closeReason: "cancelled" });
        if (tokenRef) live().hideLoading(tokenRef);
        return;
      }
      // OPS-BIZ-20: one play for the hello's tally, streamed or downloaded.
      noteHelloPlay();

      let url: string;
      const generation = ++proxyGeneration;
      try {
        url = await PlaybackBridge.startProxy({
          metadataJson: JSON.stringify(ingestMeta),
          libraryKeyBase64,
          config: proxyConfig,
        });
        if (!mounted) {
          // Backed out while the native server was coming up: the cleanup above ran before
          // `proxyStarted` was set, so stop it here (unless a newer start already replaced it).
          console.warn("playback.proxy.late_start_stopped", JSON.stringify({ generation, current: proxyGeneration }));
          if (generation === proxyGeneration) void PlaybackBridge.stopProxy().catch(() => undefined);
          return;
        }
        proxyStarted.current = true;
      } catch (err) {
        console.warn("playback.proxy.start_failed", JSON.stringify({ error: String(err) }));
        return fail("startFailed");
      }

      const markers = selectMarkersForPlayback(details.skipMarkers, episode?.id ?? null);
      const creditsStart = markers.find((m) => m.type === "credits")?.startSeconds ?? null;
      let resumeCandidateSeconds: number | null;
      if (episode) {
        const resumeMap = await resumeMapRead;
        const entry = resumeMap?.[episode.id];
        resumeCandidateSeconds = entry
          ? resolveResumeCandidateSeconds(
              entry.progressPct,
              entry.durationSeconds ?? fileDurationSeconds,
              creditsStart,
              entry.positionSeconds,
            )
          : null;
      } else {
        resumeCandidateSeconds = resolveResumeCandidateSeconds(details.progressPct, fileDurationSeconds, creditsStart);
      }
      const trackPrefs = await trackPrefsRead;

      if (!mounted) return;
      const playableTracks = new Set(tracksWithChunks);
      const nextEpisode = getNextPlayableEpisode(details, episode?.id ?? null, playableTracks);
      const previousEpisode = getPreviousPlayableEpisode(details, episode?.id ?? null, playableTracks);
      // A download on disk has no sheets and the offline proxy cannot fetch them: the seek bar stays as before.
      const previews = useOffline ? null : previewSheetsForFile(details.formats, file.id);
      setState({
        phase: "ready",
        error: null,
        playUrl: url,
        metadata: ingestMeta,
        details,
        episode,
        nextEpisode,
        previousEpisode,
        markers,
        durationSeconds: ingestMeta.videos[0]?.durationSeconds ?? fileDurationSeconds,
        resumeCandidateSeconds,
        trackPrefs,
        fetchTraffic,
        offline: useOffline,
        previews,
        closeReason: null,
      });
      if (!useOffline && !previews) {
        // MPV-PREV-04: the pictures may still be on their way (opened before the import's preview run finished).
        stopLatePreviews = watchLatePreviewSheets({
          readRevision: syncedLibraryRevision,
          sinceRevision: detailsRevision,
          readPreviews: async () => {
            const latest = await live().getMediaDetails(mediaId, { chunks: false });
            return latest ? previewSheetsForFile(latest.formats, file.id) : null;
          },
          onFound: (found) => {
            if (!mounted) return;
            console.warn("playback.previews.late", JSON.stringify({ mediaId, fileId: file.id, sheets: found.sheets.length }));
            setState((current) => (current.phase === "ready" ? { ...current, previews: found } : current));
          },
        });
      }
      console.warn(
        "playback.session.ready",
        JSON.stringify({
          markers: markers.length,
          resumeCandidateSeconds,
          nextEpisode: nextEpisode?.id ?? null,
          previousEpisode: previousEpisode?.id ?? null,
        }),
      );
      if (tokenRef) live().hideLoading(tokenRef);
    };

    void load().catch((err) => {
      console.warn("playback.load.failed", JSON.stringify({ error: String(err) }));
      fail("loadFailed");
    });
    return () => {
      mounted = false;
      stopLatePreviews?.();
      if (tokenRef) live().hideLoading(tokenRef);
      if (proxyStarted.current) {
        void PlaybackBridge.stopProxy().catch(() => undefined);
        proxyStarted.current = false;
      }
    };
  }, [attempt, episodeId, mediaId]);

  return { ...state, reload };
};
