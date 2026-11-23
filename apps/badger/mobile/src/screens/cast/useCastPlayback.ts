import { useCallback, useEffect, useRef, useState } from "react";
import { CastContext, MediaHlsSegmentFormat, MediaHlsVideoSegmentFormat, MediaPlayerIdleReason, MediaPlayerState, MediaStreamType, type CastSession } from "react-native-google-cast";
import { AirPlayPlayer, CastServer, MpvControl } from "@space/mobile-mpv-playback";
import { MediaVolume } from "@space/mobile-media-volume";
import { applySiloTrafficEvent, parseSiloTrafficEvent } from "../../lib/playback/siloTraffic";
import { connectGoogleSession, loadGoogleMedia } from "../../lib/cast/googleSession";
import { useAuth } from "../../store/auth";
import { useLibrary } from "../../store/library";
import { loadCastSource } from "../../lib/cast/castSource";
import { prepareCast, type CastSource, type CastTarget, type PrepareCastResult } from "../../lib/cast/castFlow";
import { airPlayProfile, castProfileForModel, type CastProfile } from "../../lib/cast/castProfiles";
import type { CastRefusalReason } from "../../lib/cast/castPlan";
import { CastTokenIssuer } from "../../lib/cast/castToken";
import { castTiming } from "../../lib/cast/castTiming";
import { activeCastTracks, castTrackChoices, pickCastTrack, type CastActiveTracks, type CastTrackChoices } from "../../lib/cast/castTracks";
import { airPlayMuteLevel, followsDeviceVolume } from "../../lib/cast/castVolume";
import { planStartTracks, rememberAudioPick, rememberSubtitlePick, type TrackPrefsSaver } from "../../lib/playback/trackPrefs";
import { armStartOver, commitProgressSave, createProgressGate, planProgressSave } from "../../lib/playback/progressSave";
import { selectMarkersForPlayback } from "../../lib/playback/nextEpisode";
import type { PlayerErrorCode } from "../player/usePlayerSession";
import { acquireStream, onStreamTakenOver, streamSlots } from "../../lib/playback/streamSlot";

const POLL_MS = 1000;
const SAVE_INTERVAL_MS = 5000;
const SEEK_STEP_SECONDS = 10;
/** While the volume bar is dragged, the device gets at most one volume message this often. */
const VOLUME_SEND_MS = 150;
/** Id of the one text track a cast carries (`mediaInfo.mediaTracks`). */
const SUBTITLE_TRACK_ID = 1;

/** One token issuer for the app's life: a token is never issued twice (castToken.ts). */
const issuer = new CastTokenIssuer();

export type CastPhase = "preparing" | "connecting" | "casting" | "ended" | "refused" | "error";

export type CastView = {
  phase: CastPhase;
  /** Set when `phase` is `refused`: the screen shows `cast.refused.<reason>`. */
  refusal: CastRefusalReason | null;
  /** Set when `phase` is `error`: a `cast.error.<code>` or `player.error.<code>` suffix, see `errorKey`. */
  errorKey: string | null;
  title: string;
  episodeLabel: string | null;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
  /** The audio and subtitles the user may pick (set once the device plays), and what is on the device now. */
  tracks: CastTrackChoices | null;
  active: CastActiveTracks;
  /** True while a track pick reloads the device. */
  switching: boolean;
  /** The device's volume 0..1 (null until the first reading) and whether it is muted. */
  volume: number | null;
  muted: boolean;
  /**
   * The account's stream limit closed this cast (ACCT-STREAM-02/03): `cancelled` = Cancel at "Play here instead?";
   * `takenOver` = another device took the place. The screen goes back; the alert says why.
   */
  closeReason: "cancelled" | "takenOver" | null;
};

const INITIAL: CastView = {
  phase: "preparing",
  refusal: null,
  errorKey: null,
  title: "",
  episodeLabel: null,
  playing: false,
  positionSeconds: 0,
  durationSeconds: 0,
  tracks: null,
  active: { audioIdx: null, subtitleIdx: -1 },
  switching: false,
  volume: null,
  muted: false,
  closeReason: null,
};

type Remote = {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  stop: () => Promise<void>;
  /** One reading of the device. `ended`/`failed` carry a `cast.error.*` suffix when it is a failure. */
  poll: () => Promise<{ playing: boolean; positionSeconds: number; durationSeconds: number; ended: boolean; failure: string | null }>;
  /** The device's own volume (the TV's), 0..1. */
  volume: () => Promise<{ level: number; muted: boolean }>;
  setVolume: (level: number) => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
};

const googleRemote = (session: CastSession): Remote => {
  const client = session.client;
  return {
    play: () => client.play(),
    pause: () => client.pause(),
    seek: (seconds) => client.seek({ position: Math.max(0, seconds) }),
    stop: async () => {
      await client.stop().catch(() => undefined);
      await CastContext.getSessionManager().endCurrentSession(true).catch(() => undefined);
    },
    poll: async () => {
      const [status, position] = await Promise.all([client.getMediaStatus(), client.getStreamPosition()]);
      const idle = status?.playerState === MediaPlayerState.IDLE || status == null;
      return {
        playing: status?.playerState === MediaPlayerState.PLAYING || status?.playerState === MediaPlayerState.BUFFERING,
        positionSeconds: position ?? status?.streamPosition ?? 0,
        durationSeconds: status?.mediaInfo?.streamDuration ?? 0,
        ended: idle && status?.idleReason === MediaPlayerIdleReason.FINISHED,
        failure: idle && status?.idleReason === MediaPlayerIdleReason.ERROR ? "lost" : null,
      };
    },
    // The device volume (the TV's own level, the one its remote moves), not the stream's: the hardware keys move the same
    // one (MainActivity.dispatchKeyEvent on Android, the Cast SDK's default on iOS).
    volume: async () => {
      const [level, muted] = await Promise.all([session.getVolume(), session.isMute()]);
      return { level, muted };
    },
    setVolume: async (level) => session.setVolume(Math.min(1, Math.max(0, level))),
    setMuted: async (muted) => session.setMute(muted),
  };
};

/** AirPlay: the route's volume is the iPhone's output volume while it plays there; mute is volume 0 (`airPlayMuteLevel`). */
const airPlayRemote = (): Remote => {
  let remembered: number | null = null;
  let muted = false;
  return {
    play: async () => void (await AirPlayPlayer.play()),
    pause: async () => void (await AirPlayPlayer.pause()),
    seek: async (seconds) => void (await AirPlayPlayer.seek(Math.max(0, seconds))),
    stop: async () => void (await AirPlayPlayer.stop()),
    poll: async () => {
      const state = await AirPlayPlayer.getState();
      return {
        playing: state.status === "playing",
        positionSeconds: state.position,
        durationSeconds: state.duration,
        ended: state.status === "ended",
        // `airplay_route_lost` / `airplay_not_external` come back as the failure of the player (AirPlayPlayer.swift).
        failure: state.error ? (state.error === "airplay_route_lost" ? "airplayRouteLost" : state.error === "airplay_not_external" ? "airplayNotExternal" : "lost") : null,
      };
    },
    volume: async () => {
      const level = await MediaVolume.get();
      // A hardware key that raised the volume ends the mute.
      if (level > 0) muted = false;
      return { level, muted };
    },
    setVolume: async (level) => {
      muted = false;
      remembered = null;
      await MediaVolume.set(level);
    },
    setMuted: async (next) => {
      const target = airPlayMuteLevel(next, await MediaVolume.get(), remembered);
      remembered = target.remembered;
      muted = next;
      await MediaVolume.set(target.level);
    },
  };
};

/** What the device was loaded with, kept so a track pick can reload it on the same session. */
type CastLoad = {
  source: CastSource;
  profile: CastProfile;
  title: string;
  episodeLabel: string | null;
  durationSeconds: number;
  session: CastSession | null;
};

/** The Google Cast load request of a prepared cast, and the id of its subtitle track (null when none is cast). */
const googleLoadRequest = (prepared: Extract<PrepareCastResult, { ok: true }>, load: CastLoad, startSeconds: number) => {
  const withSubtitle = Boolean(prepared.subtitleUrl && prepared.plan.subtitle);
  const request = {
    mediaInfo: {
      contentUrl: prepared.masterUrl,
      contentType: "application/x-mpegURL",
      streamType: MediaStreamType.BUFFERED,
      streamDuration: load.durationSeconds,
      hlsSegmentFormat: MediaHlsSegmentFormat.FMP4,
      hlsVideoSegmentFormat: MediaHlsVideoSegmentFormat.FMP4,
      // The chosen subtitle is a sidecar WebVTT under the token, not an HLS rendition: the receiver needs it as a text track.
      ...(prepared.subtitleUrl && prepared.plan.subtitle
        ? {
            mediaTracks: [
              {
                id: SUBTITLE_TRACK_ID,
                type: "text" as const,
                subtype: "subtitles" as const,
                contentId: prepared.subtitleUrl,
                contentType: "text/vtt",
                language: prepared.plan.subtitle.language,
                name: prepared.plan.subtitle.label,
              },
            ],
          }
        : {}),
      metadata: { type: "generic" as const, title: load.episodeLabel ? `${load.title} ${load.episodeLabel}` : load.title },
    },
    startTime: startSeconds,
    autoplay: true,
    // The subtitle is switched on in the load (iOS) and again right after it (Android): see `loadGoogleMedia`.
    ...(withSubtitle ? { activeTrackIds: [SUBTITLE_TRACK_ID] } : {}),
  };
  return { request, subtitleTrackId: withSubtitle ? SUBTITLE_TRACK_ID : null };
};

/**
 * One cast from start to stop (UX-TV-03): loads the file, plans and refuses, serves it from the phone's Wi-Fi address,
 * hands the stream to the device and reports its position. The phone never plays the film itself: leaving the screen
 * (or `stop`) ends the cast, closes the LAN server and saves where the device was.
 */
export const useCastPlayback = (mediaId: string, episodeId: string | null, target: CastTarget) => {
  const { token } = useAuth();
  const library = useLibrary();
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [view, setView] = useState<CastView>(INITIAL);
  const remote = useRef<Remote | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const saveState = useRef({ gate: createProgressGate(), lastPosition: null as number | null, lastAt: 0, episodeId: null as string | null, creditsStart: null as number | null });
  const stopped = useRef(false);
  const unsubscribeTraffic = useRef<(() => void) | null>(null);
  const castLoad = useRef<CastLoad | null>(null);
  /** Set while a track pick reloads the device: the poll must not read the swap as an end or a failure. */
  const switching = useRef(false);
  const volumeState = useRef({ lastLocalAt: 0, lastSentAt: 0 });

  const save = useCallback(
    (final: boolean, completed = false) => {
      const current = viewRef.current;
      if (current.phase !== "casting" && current.phase !== "ended") return;
      const st = saveState.current;
      const plan = planProgressSave(st.gate, {
        positionSeconds: current.positionSeconds,
        durationSeconds: current.durationSeconds,
        lastSavedPositionSeconds: st.lastPosition,
        final,
        completed,
        creditsStartSeconds: st.creditsStart,
      });
      if (!plan) return;
      commitProgressSave(st.gate, plan);
      st.lastPosition = plan.positionSeconds;
      st.lastAt = Date.now();
      void libraryRef.current
        .setPlaybackProgress(mediaId, st.episodeId, plan.progressPct, { positionSeconds: plan.positionSeconds, durationSeconds: plan.durationSeconds }, final)
        .catch((err) => console.warn("[cast] progress save failed", JSON.stringify({ error: String(err) })));
      console.info("[cast] progress", JSON.stringify({ pct: Number(plan.progressPct.toFixed(2)), position: Math.round(plan.positionSeconds), final, completed }));
    },
    [mediaId],
  );

  const stop = useCallback(async () => {
    if (stopped.current) return;
    stopped.current = true;
    unsubscribeTraffic.current?.();
    unsubscribeTraffic.current = null;
    save(true, viewRef.current.phase === "ended");
    const active = remote.current;
    remote.current = null;
    await active?.stop().catch((err) => console.warn("[cast] remote stop failed", JSON.stringify({ error: String(err) })));
    await CastServer.stop().catch(() => undefined);
    issuer.revoke();
    void MpvControl.setKeepScreenOn(false).catch(() => undefined);
    // ACCT-STREAM-04: the cast's place is given back (not a place the player took since).
    void streamSlots.release("cast");
    console.info("[cast] stopped");
  }, [save]);

  useEffect(() => {
    stopped.current = false;
    let alive = true;
    // Aborts a session start still pending when the screen closes (see `connectGoogleSession`).
    const abort = new AbortController();
    // The phone is the sender for the whole film: keep it awake so the LAN server and the Wi-Fi stay up.
    void MpvControl.setKeepScreenOn(true).catch(() => undefined);

    // The cast server opens the tunnel session itself, so it is the one that hears the gateway (STOR-BW-07, STOR-BW-08): a
    // refusal or a stop of this viewer ends the cast with the reason. A cast cannot step its quality down, so a saturation
    // report without a stop changes nothing here.
    unsubscribeTraffic.current = CastServer.onTraffic((raw) => {
      const event = parseSiloTrafficEvent(raw);
      if (!event || !alive) return;
      const { unavailable } = applySiloTrafficEvent(null, event);
      if (!unavailable) return;
      console.warn("[cast] silo ended the cast", JSON.stringify({ unavailable }));
      save(true);
      void stop();
      setView((v) => ({ ...v, phase: "error", errorKey: `player.error.${unavailable}`, playing: false }));
    });

    // ACCT-STREAM-02: another device took the place over: the cast stops and the screen goes back.
    const stopListening = onStreamTakenOver(() => {
      if (!alive) return;
      console.warn("[cast] stream taken over");
      void stop();
      setView((v) => ({ ...v, playing: false, closeReason: "takenOver" }));
    });

    const run = async () => {
      if (!token) return;
      castTiming("screen");
      const loaded = await loadCastSource(libraryRef.current, token, mediaId, episodeId);
      castTiming("source", { ok: loaded.ok });
      if (!alive) return;
      if (!loaded.ok) {
        setView({ ...INITIAL, phase: "error", errorKey: `player.error.${loaded.code satisfies PlayerErrorCode}` });
        return;
      }
      const { source, details, episode, startSeconds, durationSeconds, trackPrefs } = loaded.value;
      const title = details.title;
      const episodeLabel = episode ? `S${episode.seasonNumber}E${episode.episodeNumber}` : null;
      saveState.current.episodeId = episode?.id ?? null;
      saveState.current.creditsStart = selectMarkersForPlayback(details.skipMarkers, episode?.id ?? null).find((m) => m.type === "credits")?.startSeconds ?? null;
      if (startSeconds === 0) armStartOver(saveState.current.gate);
      setView({ ...INITIAL, title, episodeLabel, phase: "preparing", durationSeconds });

      // ACCT-STREAM-03: casting is this phone's stream (kind `cast`; the receiver takes none). A download cast from
      // disk never asks.
      const slotAnswer = await acquireStream({ token, kind: "cast", owner: "cast", offline: source.proxyConfig.clientKind === "offline" });
      if (!alive) return;
      if (slotAnswer === "cancel") {
        console.warn("[cast] stream slot cancelled");
        setView((v) => ({ ...v, closeReason: "cancelled" }));
        return;
      }

      const profile = target.kind === "airplay" ? airPlayProfile() : castProfileForModel(target.modelName);
      const startTracks = planStartTracks(trackPrefs, source.metadata.audioTracks, source.metadata.subtitleTracks);
      // The receiver's launch (about 4 s on a Google TV) is the longest step of a cast start: it starts as soon as the title
      // is known to be castable, while the server starts and the subtitle is converted, not after (UX-TV-03 cast-start
      // latency). A refusal or a failed server never reaches it.
      let sessionStart = null as Promise<CastSession> | null;
      const prepared = await prepareCast({
        source,
        profile,
        startTracks,
        server: CastServer,
        issuer,
        startSeconds,
        onPlanned: () => {
          if (target.kind !== "google-cast") return;
          castTiming("session.requested");
          sessionStart = connectGoogleSession(CastContext.getSessionManager(), target.deviceId, { signal: abort.signal });
          // Awaited below; a rejection while the server still starts must not surface as unhandled.
          sessionStart.catch(() => undefined);
        },
      });
      castTiming("prepared", { ok: prepared.ok });
      if (!alive) {
        await CastServer.stop().catch(() => undefined);
        // A session that came up while the server started belongs to this closed screen: end it on the device too.
        if (sessionStart) await CastContext.getSessionManager().endCurrentSession(true).catch(() => undefined);
        return;
      }
      if (!prepared.ok) {
        if (sessionStart) {
          // The session was asked for but the server failed: the device must not keep a session nobody drives.
          abort.abort();
          await CastContext.getSessionManager().endCurrentSession(true).catch(() => undefined);
        }
        const refused = prepared.reason !== "error";
        setView({
          ...INITIAL,
          title,
          episodeLabel,
          phase: refused ? "refused" : "error",
          refusal: refused ? prepared.reason : null,
          errorKey: !refused && prepared.reason === "error" ? `cast.error.${prepared.code}` : null,
        });
        return;
      }

      setView((v) => ({ ...v, phase: "connecting" }));
      const load: CastLoad = { source, profile, title, episodeLabel, durationSeconds, session: null };
      try {
        if (target.kind === "google-cast") {
          const session = await (sessionStart ?? connectGoogleSession(CastContext.getSessionManager(), target.deviceId, { signal: abort.signal }));
          castTiming("session");
          if (!alive) {
            // The screen closed while the session was starting: the device must not keep a session nobody drives.
            await session.client.stop().catch(() => undefined);
            await CastContext.getSessionManager().endCurrentSession(true).catch(() => undefined);
            return;
          }
          load.session = session;
          // Timing only: the receiver's first BUFFERING and PLAYING after the load (see castTiming.ts).
          const seen = new Set<string>();
          const statusTiming = session.client.onMediaStatusUpdated((status) => {
            const state = status?.playerState;
            if (!state || seen.has(state)) return;
            seen.add(state);
            castTiming(`receiver.${state}`, { position: status?.streamPosition ?? null });
            if (state === MediaPlayerState.PLAYING) statusTiming.remove();
          });
          castTiming("load.sent");
          const { request, subtitleTrackId } = googleLoadRequest(prepared, load, startSeconds);
          await loadGoogleMedia(session.client, request, subtitleTrackId);
          castTiming("load.done");
          remote.current = googleRemote(session);
        } else {
          await AirPlayPlayer.load(prepared.masterUrl, startSeconds);
          remote.current = airPlayRemote();
        }
      } catch (err) {
        // A closed screen already stopped its server; the session and server now may belong to a newer cast: leave them.
        if (!alive) return;
        console.warn("[cast] hand-over failed", JSON.stringify({ target: target.kind, error: String(err) }));
        await CastServer.stop().catch(() => undefined);
        // A Google session that started but did not take the stream must not stay open on the device.
        if (target.kind === "google-cast") await CastContext.getSessionManager().endCurrentSession(true).catch(() => undefined);
        const noRoute = String(err).includes("airplay_no_route");
        setView({ ...INITIAL, title, episodeLabel, phase: "error", errorKey: noRoute ? "cast.error.airplayNoRoute" : target.kind === "airplay" ? "cast.error.loadFailed" : "cast.error.sessionFailed" });
        return;
      }
      if (!alive) return;
      castLoad.current = load;
      const tracks = castTrackChoices(source.metadata, profile);
      const active = activeCastTracks(source.metadata, prepared.plan);
      console.info("[cast] tracks", JSON.stringify({ audio: tracks.audio.map((c) => c.idx), subtitles: tracks.subtitles.map((c) => c.idx), active }));
      setView((v) => ({ ...v, phase: "casting", positionSeconds: startSeconds, playing: true, tracks, active }));
    };

    void run().catch((err) => {
      console.warn("[cast] failed", JSON.stringify({ error: String(err) }));
      if (alive) setView({ ...INITIAL, phase: "error", errorKey: "cast.error.serverFailed" });
    });

    const timer = setInterval(() => {
      const active = remote.current;
      if (!active || viewRef.current.phase !== "casting" || switching.current) return;
      void active
        .volume()
        .then((reading) => {
          if (!alive || remote.current !== active || !followsDeviceVolume(volumeState.current.lastLocalAt, Date.now())) return;
          setView((v) => (v.volume === reading.level && v.muted === reading.muted ? v : { ...v, volume: reading.level, muted: reading.muted }));
        })
        .catch((err) => console.warn("[cast] volume read failed", JSON.stringify({ error: String(err) })));
      void active
        .poll()
        .then((reading) => {
          if (!alive || remote.current !== active || switching.current) return;
          if (reading.failure) {
            save(true);
            void stop();
            setView((v) => ({ ...v, phase: "error", errorKey: `cast.error.${reading.failure}`, playing: false }));
            return;
          }
          setView((v) => ({
            ...v,
            phase: reading.ended ? "ended" : v.phase,
            playing: reading.playing && !reading.ended,
            positionSeconds: reading.positionSeconds,
            durationSeconds: reading.durationSeconds > 0 ? reading.durationSeconds : v.durationSeconds,
          }));
          if (reading.ended) {
            save(true, true);
          } else if (Date.now() - saveState.current.lastAt >= SAVE_INTERVAL_MS) {
            save(false);
          }
        })
        .catch((err) => console.warn("[cast] poll failed", JSON.stringify({ error: String(err) })));
    }, POLL_MS);

    return () => {
      stopListening();
      alive = false;
      abort.abort();
      clearInterval(timer);
      void stop();
    };
    // The target is fixed for the screen's life (the route is keyed by it).
  }, [mediaId, episodeId, token]);

  /** Plays (`true`) or pauses (`false`) on the device; the view follows at once, the next poll corrects it. */
  const setPlaying = useCallback(async (playing: boolean) => {
    const active = remote.current;
    if (!active) return;
    setView((v) => ({ ...v, playing }));
    await (playing ? active.play() : active.pause()).catch((err) => console.warn("[cast] play/pause failed", JSON.stringify({ error: String(err) })));
  }, []);

  const togglePlay = useCallback(() => setPlaying(!viewRef.current.playing), [setPlaying]);

  const seekTo = useCallback(async (seconds: number) => {
    const active = remote.current;
    if (!active) return;
    const duration = viewRef.current.durationSeconds;
    const target = duration > 0 ? Math.min(seconds, duration) : seconds;
    setView((v) => ({ ...v, positionSeconds: Math.max(0, target) }));
    await active.seek(target).catch((err) => console.warn("[cast] seek failed", JSON.stringify({ error: String(err) })));
  }, []);

  const seekBy = useCallback((direction: 1 | -1) => seekTo(viewRef.current.positionSeconds + direction * SEEK_STEP_SECONDS), [seekTo]);

  /**
   * Picks an audio track or a subtitle (-1 = off) on the device (UX-TV-03). The cast carries one subtitle and leads with
   * one audio track, so a pick re-plans the cast, restarts the phone's server under a new token and reloads the device
   * where it was, on the same Cast session. The pick is remembered for the title, as in the player.
   */
  const selectTrack = useCallback(
    async (pick: { kind: "audio"; idx: number } | { kind: "subtitle"; idx: number }) => {
      const load = castLoad.current;
      const current = viewRef.current;
      if (!load || !current.tracks || current.phase !== "casting" || switching.current) return;
      const startTracks = pickCastTrack(current.tracks, current.active, pick);
      console.info("[cast] track pick", JSON.stringify({ pick, active: current.active, startTracks }));
      if (!startTracks) return;
      const metadata = load.source.metadata;
      const saveTrackPrefs: TrackPrefsSaver = (id, patch) => libraryRef.current.setTrackPrefs(id, patch);
      if (pick.kind === "audio") {
        const track = metadata.audioTracks[pick.idx];
        if (track) void rememberAudioPick(saveTrackPrefs, mediaId, track);
      } else {
        void rememberSubtitlePick(saveTrackPrefs, mediaId, pick.idx >= 0 ? (metadata.subtitleTracks[pick.idx] ?? null) : null);
      }

      switching.current = true;
      const at = current.positionSeconds;
      const wasPlaying = current.playing;
      setView((v) => ({ ...v, switching: true }));
      try {
        await CastServer.stop().catch(() => undefined);
        const prepared = await prepareCast({ source: load.source, profile: load.profile, startTracks, server: CastServer, issuer, startSeconds: at });
        if (stopped.current) {
          await CastServer.stop().catch(() => undefined);
          return;
        }
        if (!prepared.ok) {
          console.warn("[cast] track pick refused", JSON.stringify({ reason: prepared.reason, detail: prepared.detail }));
          save(true);
          void stop();
          const refused = prepared.reason !== "error";
          setView((v) => ({
            ...v,
            phase: refused ? "refused" : "error",
            refusal: refused ? prepared.reason : null,
            errorKey: !refused && prepared.reason === "error" ? `cast.error.${prepared.code}` : null,
            playing: false,
          }));
          return;
        }
        if (load.session) {
          const { request, subtitleTrackId } = googleLoadRequest(prepared, load, at);
          await loadGoogleMedia(load.session.client, request, subtitleTrackId);
        } else {
          await AirPlayPlayer.load(prepared.masterUrl, at);
        }
        if (!wasPlaying) await remote.current?.pause().catch(() => undefined);
        const active = activeCastTracks(metadata, prepared.plan);
        console.info("[cast] track switched", JSON.stringify({ active, at: Math.round(at) }));
        setView((v) => ({ ...v, active, positionSeconds: at, playing: wasPlaying }));
      } catch (err) {
        console.warn("[cast] track switch failed", JSON.stringify({ error: String(err) }));
        save(true);
        void stop();
        setView((v) => ({ ...v, phase: "error", errorKey: "cast.error.loadFailed", playing: false }));
      } finally {
        switching.current = false;
        setView((v) => ({ ...v, switching: false }));
      }
    },
    [mediaId, save, stop],
  );

  /**
   * Sets the device's volume (0..1). `drag` while the bar moves: the device gets at most one message per VOLUME_SEND_MS;
   * `end` always sends. Readings of the device are ignored for a moment after (`followsDeviceVolume`).
   */
  const setVolume = useCallback((level: number, phase: "drag" | "end" = "end") => {
    const active = remote.current;
    if (!active) return;
    const now = Date.now();
    const st = volumeState.current;
    st.lastLocalAt = now;
    setView((v) => ({ ...v, volume: level, muted: false }));
    if (phase === "drag" && now - st.lastSentAt < VOLUME_SEND_MS) return;
    st.lastSentAt = now;
    if (phase === "end") console.info("[cast] volume", JSON.stringify({ level: Number(level.toFixed(2)) }));
    void active.setVolume(level).catch((err) => console.warn("[cast] volume set failed", JSON.stringify({ error: String(err) })));
  }, []);

  const toggleMute = useCallback(() => {
    const active = remote.current;
    if (!active) return;
    const muted = !viewRef.current.muted;
    volumeState.current.lastLocalAt = Date.now();
    setView((v) => ({ ...v, muted }));
    console.info("[cast] mute", JSON.stringify({ muted }));
    void active.setMuted(muted).catch((err) => console.warn("[cast] mute failed", JSON.stringify({ error: String(err) })));
  }, []);

  return { view, setPlaying, togglePlay, seekTo, seekBy, selectTrack, setVolume, toggleMute, stop };
};
