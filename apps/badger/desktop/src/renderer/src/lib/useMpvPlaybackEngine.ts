import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioOption, SubtitleOption, UsePlaybackEngineParams } from "@/lib/playbackTypes";
import {
  createHiddenCoalescedSetter,
  createVisibilityAwareInterval,
  isAppWindowHidden,
  subscribeAppWindowVisibility,
} from "@/lib/appWindowVisibility";
import { buildChunkMapFromFormat, buildHlsTrackFromChunkMap, type ChunkMap } from "@/lib/mpvPlaybackMaps";
import {
  autoPlayAllowed,
  isUserPause,
  markSentPauseSeen,
  shouldForceResumeExternalPlayback,
  type SentPause,
} from "@/lib/mpvPlaybackResilience";
import { usePlaybackSaturation } from "@/lib/usePlaybackSaturation";
import { offlineManifestPathForFile } from "@/lib/offlineState";
import {
  buildMpvPlaybackState,
  externalLaunchStartedAt,
  hasLiveExternalPlayer,
  isExternalActive,
  isExternalReady,
  isPlaybackReloadReady,
} from "@/lib/mpvPlaybackState";
import { useExternalMpvCommands } from "@/lib/useExternalMpvCommands";
import { formatPlayerTrackLabel } from "@/lib/playerTrackLabel";
import { formatNowPlayingParts } from "@space/shared/nowPlaying";
import { isOcrTwin } from "@space/shared/subtitleTwins";
import { isRemovableSubtitleSource } from "@space/shared/subtitleFetch";
import { useMpvSubtitleFetch } from "@/lib/useMpvSubtitleFetch";
import { getDecryptedAssetUrl, isAssetKey } from "@/lib/assets";
import { getStoredLibraryKey } from "@/lib/onboarding";
import { objectUrlToDataUrl, resolvePlaybackBackdrop } from "@/lib/playbackBackdrop";
import { formatLaunchTimeline, runPrelaunchLoads } from "@/lib/playbackPrelaunch";
import {
  buildExternalMetadataCommands,
  buildExternalPlaybackMetadataPayload,
  missingPreviewsFor,
  sourcePreviewSheets,
  oscMenuPrompts,
  type ExternalPlaybackMetadataPayload,
} from "@/lib/mpvExternalMetadata";
import { createPreviewSheetsHandoff } from "@/lib/previewSheetsHandoff";
import { sendMetadataBatch, sendMetadataWithBackoff } from "@/lib/mpvMetadataBackoff";
import {
  buildPlaybackChapters,
  buildPlaybackFormatsForFile,
  buildPlaybackSkipMarkers,
  hasPlayableAudioTrack,
  hlsAudioTrackFor,
  waitForSafeTrackSwitch,
  resolveNextEpisodeFormatId,
  resolvePlaybackAudioState,
  resolvePlaybackSubtitleState,
} from "@/lib/mpvPlaybackSelection";
import {
  awaitHandoffLoadfile,
  awaitReloadLoadfile,
  createNewEntryEndFileFilter,
  classifyExternalLoadSignal,
  createPlaybackPhaseStore,
  decidePolledProgressSave,
  type ExternalLoadVerdict,
  type ReloadLoadfileOutcome,
  deriveIsReadyToReveal,
  isLoadInFlight,
  getSharedPreloadMpvClient,
  shouldIgnoreExternalTeardownDuringLaunch,
  shouldPersistPlaybackProgress,
  shouldTeardownExternalPlayback,
  shouldTreatRecoveredExternalStateAsReady,
  fillLateSidecars,
  splitLaunchSidecars,
  useMpvLifecycleStore,
  usePlaybackPhaseSelector,
  type LateSubtitleSidecars,
  type PhaseEvent,
  type ProgressSaveTarget,
  type SubtitleSidecar,
  type SubtitleSidecarCache,
} from "@space/desktop-mpv-playback";
import {
  buildGetPropertyCommand,
  buildScriptMessageCommand,
  buildLoadfileCommand,
  buildSeekCommand,
  buildSetPropertyCommand,
  buildSubAddCommand,
  buildSubRemoveCommand,
  findExternalSubtitle,
  getProperty,
  LUA_CHANNELS,
  type LifecycleState,
  type MpvTrack,
} from "@space/mpv-protocol";

// PR 4.1a: `isExternalActive` / `isExternalReady` / `externalLaunchStartedAt`
// moved to `lib/mpvPlaybackState.ts` so the new `useExternalMpvCommands`
// facade can share them. Imported below alongside the existing
// buildMpvPlaybackState consumer.
import { DESKTOP_DEFAULT_CACHE_CONFIG, readMpvCacheConfig } from "@/lib/abrCacheConfig";
import { resolveSeekDuration } from "@/lib/mediaPlaybackTimeline";
import {
  HLS_MASTER_FALLBACK_ERROR,
  watchHlsMasterFallback,
  type HlsMasterFallbackWatch,
} from "@/lib/hlsMasterFallbackWatch";
import {
  createAbrController,
  needsH264Fallback,
  noteFirstFrame,
  noteLaunch,
  noteLoadStarted,
  noteSeek,
  noteReloadStarted,
  resetLagDetector,
  noteSessionStarted,
  noteSwitchSettled,
  qualityRank,
  stepDecoder,
  stepNetworkAbr,
  capCeilingRank,
  capTarget,
  type AbrSample,
  type CacheConfig,
  type DownshiftHeld,
  type Variant,
} from "@space/playback-abr";
import {
  parseOscSeekMessage,
  PendingStartTarget,
  resolveFormatSwitchResumeTime,
  resolveReloadStartTime,
} from "@/lib/pendingStartTarget";
import { PrematureEofRecovery } from "@/lib/prematureEofRecovery";
import {
  OscTrackPicks,
  parseTrackPickedMessage,
  resolvePickedSubtitleOptionId,
  trackPrefsPatchForPick,
} from "@/lib/oscTrackPicks";
import { findHlsVariantVid, hlsVariantBandwidthBps, resolvePickedVideoFormatId } from "@/lib/hlsVariantPick";
import {
  decideInitEntry,
  decideIntentConsume,
  PendingFormatSwitch,
  type FormatSwitchSettleReason,
  shouldRetryDeferredSwitch,
} from "@/lib/formatSwitchReload";
import {
  PLAYBACK_LOAD_STOPPED,
  isPlaybackLoadStopped,
  playbackLoadFailureKey,
  runReportingLoadFailure,
} from "@/lib/playbackLoadFailure";
import { acquireDesktopStreamSlot, releaseDesktopStreamSlot } from "@/lib/streamSlot";
import { isQualityPreset, type QualityPreset } from "@/lib/config";
import type { MediaFormat } from "@/lib/libraryDb";
import { notify } from "@/lib/notify";
import { rendererLogger } from "@/logger";

const playbackDebugLog = rendererLogger.child({ scope: "playback-debug" });
const mpvLog = rendererLogger.child({ scope: "mpv" });
const mpvSubtitleLog = rendererLogger.child({ scope: "mpv-subtitle" });
const subPipelineLog = rendererLogger.child({ scope: "sub-pipeline" });
const abrLog = rendererLogger.child({ scope: "playback-abr" });

// ABR decision cadence: the high-frequency poll runs at 250ms for time-pos and
// other UI state. The ABR decision only needs ~1 Hz — running it every cycle
// wastes IPC bandwidth on `demuxer-cache-state` and creates noisy logs. Skip
// every 3 out of 4 cycles.
const ABR_DECIDE_EVERY_N_POLLS = 4;

const ZERO_SEEK_EPS = 0.25;

const EXTERNAL_MPV_SESSION_EVENT = "sf:external-mpv-session";

const NO_BLOCKED_CODECS: ReadonlySet<string> = new Set();

const toVariants = (formats: MediaFormat[]): Variant[] =>
  formats
    .filter((f) => isQualityPreset(f.quality))
    .map((f) => ({
      id: f.id,
      quality: f.quality,
      bitrateKbps: f.bitrateKbps ?? null,
      codec: f.codec || null,
    }));

type HlsSession = {
  id: string;
  url: string;
};

export const useMpvPlaybackEngine = ({
  open,
  media,
  libraryFormats,
  episodeId,
  previousEpisode,
  nextEpisode,
  token,
  blockAutoPlay,
  deferPlayback,
  playbackQuality,
  forcePlaybackQuality,
  autoplayNextEpisode,
  autoSkipIntro,
  autoSkipCredits,
  setMediaFormatChunks,
  setProgress,
  trackPrefs,
  setTrackPrefs,
  addSubtitleTrack,
  removeSubtitleTrack,
  getMediaObjectKeys,
  t,
}: UsePlaybackEngineParams) => {
  const playerRef = useRef<HTMLCanvasElement | null>(null);
  // The latest writer, read from the OSC pick listener (not an effect dep).
  const setTrackPrefsRef = useRef(setTrackPrefs);
  setTrackPrefsRef.current = setTrackPrefs;
  const [playerReady, setPlayerReady] = useState(false);
  const setPlayerNode = useCallback(() => {
    // External mpv does not render into a canvas.
  }, []);

  const hlsSessionRef = useRef<HlsSession | null>(null);
  // Offline playback (OFFL-FILE-03): id of the active HLS session over the pieces saved on this device, so we can
  // release it when switching sources / tearing down, and the subtitles saved with it (the only ones offered: their
  // object URLs serve the local pieces). @bugfix offline-playback-ignored-local-file
  const offlineSessionRef = useRef<string | null>(null);
  const offlineSubtitleKeysRef = useRef<ReadonlySet<string> | null>(null);
  const wasOpenRef = useRef(open);
  const lastKnownTimeRef = useRef(0);
  const seekTargetRef = useRef<number | null>(null);
  // The start a launch / reload / seek asked for, held until mpv's reported
  // position reaches it. @bugfix issue #25 P8 — see pendingStartTarget.ts.
  const [pendingStart] = useState(() => new PendingStartTarget());
  const autoPlayRef = useRef(true);
  const lastProgressRef = useRef({ pct: 0, at: 0 });
  const blockAutoPlayRef = useRef(blockAutoPlay);
  // PR 3.2b-flip: `manualStartRef` was subsumed by `phase.lastConsumedIntent`
  // (set by startFrom's set_intent_pending dispatch; consumed by the init
  // effect's consume guard via consume_intent).

  const playbackBaseRef = useRef<string | null>(null);
  const playbackBasePromiseRef = useRef<Promise<string> | null>(null);
  const mpvFlagsRef = useRef<{ smokeTest: boolean; externalPlayer: boolean }>(
    window.sf?.getMpvFlags?.() ?? { smokeTest: false, externalPlayer: false }
  );
  // The transport client that wraps `window.sf.sendExternalMpv*`. Shared
  // module-scope singleton so the cached lifecycle state survives across
  // engine remounts (e.g. MediaPlaybackController's `key={mediaId:requestId}`
  // in MediaDetailsDialog + Dashboard). Constructing a fresh client per
  // mount produced a stale `{ kind: "idle" }` cache that short-circuited
  // every `isExternalActive(lifecycleRef.current)` gate predicate, sending
  // the launch branch into a respawn loop. See @bugfix
  // preloadmpvclient-remount-idle-race in `getSharedPreloadMpvClient`.
  const mpvClient = getSharedPreloadMpvClient();

  // Tier-5 — lifecycle snapshot. Replaces 6 renderer-local lifecycle refs
  // (externalMpvActiveRef, externalMpvReadyRef, externalMpvReadyPromiseRef,
  // externalLogFileRef, externalLaunchStartedAtRef,
  // lastExternalResumeAttemptAtRef). The main-process UnixSocketMpvClient
  // dispatches the pure reducer in @space/mpv-protocol on every event source
  // and pushes the resulting state through subscribeLifecycle; this hook
  // delivers the cached state synchronously on mount, so the engine never
  // sees a transient "idle" race when re-mounting mid-launch.
  //
  // `lifecycleRef` mirrors the snapshot so closures (poll loops, async
  // callbacks created inside useCallback) can read the latest value without
  // depending on `lifecycle` in their dependency array.
  const lifecycle = useMpvLifecycleStore(mpvClient);
  const lifecycleRef = useRef<LifecycleState>(lifecycle);
  lifecycleRef.current = lifecycle;
  // PR 3.2c-3: the concurrency latches `launchInProgressRef` +
  // `initEffectInFlightRef` are subsumed by `isLoadInFlight(phaseRef.current)`.
  // The phase machine's `launching` / `backdropHandoff` / `reloading{streamLoaded:false}`
  // states cover the same in-flight window with a single source of truth.
  // start_load dispatches synchronously at the init-effect top (PR 3.2c-2)
  // and at the startFrom zero-seek path, BEFORE any await — closing the
  // pre-loadStream-await race that originally motivated initEffectInFlightRef.
  // @bugfix mpv-launch-loop-from-controller-mount-storm (phase-resolved)
  // @bugfix mpv-launch-init-effect-pre-loadstream-window (phase-resolved)
  // @bugfix mpv-launch-init-effect-sequential-refire (phase-resolved)
  // PR 3.2a: the (fileId, audioMapSignature, effectiveFormatSignature) tuple
  // of the most recently launched session now lives in
  // `phaseRef.current.lastLaunchedKey`. The init effect compares the current
  // tuple against `phase.lastLaunchedKey` on re-entry; if they match AND
  // mpv is still alive, the launch already covered the current state so
  // the effect skips re-invoking loadStream. Cleared by the phase reducer
  // on `process_gone` (mirrors the previous lifecycle→idle clear).
  // @bugfix mpv-launch-init-effect-post-launch-refire
  //
  // Phase 3 of the playback-engine hardening — `playbackPhase` reducer
  // (`@space/desktop-mpv-playback/playbackPhase`) replacing nine implicit
  // flag refs in this file with one explicit phase + three predicates
  // (seeksAllowed / deriveIsReadyToReveal / isLoadInFlight).
  //
  // PR 3.1 shipped this in shadow mode (engine dispatches at every
  // flag-write site; flags authoritative; equivalence assertions at the
  // seek gate, init guard, and ABR gate — verified zero divergence under
  // `bun run gate:desktop-release`). PR 3.2 incrementally flips each
  // reader to phase + deletes the corresponding flag:
  //   - 3.2a (this commit) lastLaunchedKey → phase.lastLaunchedKey
  //   - 3.2b skipExternalInit + manualStart → phase.intent (launching)
  //   - 3.2c latches (launchInProgress + initEffectInFlight) → isLoadInFlight(phase)
  //   - 3.2d streamLoadfileComplete → seeksAllowed(phase) [@regression-proof]
  //   - 3.2e isReadyToReveal → deriveIsReadyToReveal(phase) [public API]
  //
  // Shadow-mode invariants:
  //   1. Flags REMAIN authoritative. No production read site consumes
  //      `phaseRef` yet — that flip lands in PR 3.2.
  //   2. The engine dispatches phase events at every flag-write site below.
  //      Failure to dispatch is a structural bug to fix here, NOT later.
  //   3. Dev-only equivalence assertions land in PR 3.1c at the seek gate,
  //      init guard, and ABR gate; they verify the phase reducer agrees with
  //      the flag-derived predicates BEFORE any flag deletion.
  // (Phase 3 of the playback-engine hardening plan.)
  // PR 3.2e: the phase reducer lives in a useSyncExternalStore-backed
  // store so the engine's `isReadyToReveal` public return value
  // (consumed by MediaPlaybackController.tsx) re-renders reactively
  // when the phase changes. `phaseRef` is a synchronous mirror so the
  // non-React read sites (seek gate, init guard, ABR gate, runtime
  // logs) stay synchronous — `dispatchPhase` updates it inline after
  // the reducer runs.
  const phaseStore = useMemo(() => createPlaybackPhaseStore(), []);
  const phaseRef = useRef(phaseStore.getSnapshot());
  const dispatchPhase = useCallback(
    (event: PhaseEvent) => {
      const prev = phaseStore.getSnapshot();
      phaseStore.dispatch(event);
      const next = phaseStore.getSnapshot();
      if (prev !== next) {
        phaseRef.current = next;
        if (import.meta.env.DEV) {
          mpvLog.debug(
            {
              event: event.type,
              from: prev.kind,
              to: next.kind,
            },
            "[playbackPhase] dispatch",
          );
        }
      }
    },
    [phaseStore],
  );
  // PR 3.2e refinement: subscribe via a SELECTOR that returns just the
  // derived boolean. The engine re-renders ONLY when the boolean flips
  // (not on every phase reference change). Cross-cutting field updates
  // (stamp_launched_key, set_intent_pending, set_reload_signature) do
  // not affect deriveIsReadyToReveal — they update phaseRef synchronously
  // without re-rendering the engine. Restores the pre-3.2e re-render
  // cadence (only flips when isReadyToReveal value changes).
  const isReadyToReveal = usePlaybackPhaseSelector(
    phaseStore,
    deriveIsReadyToReveal,
  );

  // Synchronous lifecycle mirror — subscribe directly to the shared mpv
  // client so `lifecycleRef.current` reflects the latest cached state
  // BETWEEN renders. Without this, the gate predicates in waitForVoConfigured
  // / waitForMetadataApplied read the LAST COMMITTED React snapshot, which
  // lags behind the cache when a lifecycle event arrives after a render
  // starts but before the next render commits — the engine's async launch
  // flow then sees stale "idle" and bails. Logs every transition so we can
  // see in field traces exactly which state the renderer thinks it's in.
  useEffect(() => {
    return mpvClient.subscribeLifecycle((state) => {
      const previousKind = lifecycleRef.current.kind;
      lifecycleRef.current = state;
      if (previousKind !== state.kind) {
        mpvLog.info({ from: previousKind, to: state.kind }, "lifecycleRef sync");
        // Clear the post-launch idempotency stamp when mpv goes back to
        // idle so the next legitimate launch isn't blocked. The stamp
        // covers a single launch session; once mpv exits the session
        // is gone and a fresh loadStream is needed.
        // @bugfix mpv-launch-init-effect-post-launch-refire
        // PR 3.2a: the phase reducer's process_gone event clears
        // `phase.lastLaunchedKey` in addition to resetting kind→idle.
        if (state.kind === "idle") {
          dispatchPhase({ type: "process_gone" });
        }
      }
    });
  }, [dispatchPhase, mpvClient]);

  // Tier-4 — feature-flagged observe_property snapshot cache. When the flag
  // is on, the 6 push-friendly properties (time-pos, duration, pause, mute,
  // volume, eof-reached) are pushed by mpv via the multiplexed channel and
  // written into this map; the poll loop reads them from memory instead of
  // issuing IPC get_property calls. Cuts JS↔mpv traffic by ~6/9 per poll
  // cycle. The flag is read once per launch via `import.meta.env`-style
  // process.env lookup so flipping it requires an app restart, which keeps
  // the wire/refactor blast radius tight.
  //
  // When the flag is unset (the Tier-4 ship default), the poll handles all
  // 9 properties exactly as before — no behavior change. The poll path
  // remains the canonical source of truth until Tier-6 retires it.
  const observePropertyEnabledRef = useRef(
    typeof process !== "undefined" && process?.env?.SF_MPV_OBSERVE_PROPERTY === "1",
  );
  // null marks "not observed yet"; the poll falls back to its own IPC read
  // until the first push lands. Subsequent pushes overwrite — the type stays
  // `T | null` so the poll's existing typeof-narrowing keeps working.
  const observedTimePosRef = useRef<number | null>(null);
  const observedDurationRef = useRef<number | null>(null);
  const observedPauseRef = useRef<boolean | null>(null);
  const observedMuteRef = useRef<boolean | null>(null);
  const observedVolumeRef = useRef<number | null>(null);
  const observedEofRef = useRef<boolean | null>(null);

  // ABR state: the shared `@space/playback-abr` controller (anti-flap clocks, downshift holds, the upshift gate). Throughput
  // comes from the main-process link meter (`window.sf.getPlaybackLinkEstimate`): mpv's own byte counters only gauge its
  // cache, issue #25. No rung is ever banned after a network downshift: Auto climbs back up when the network recovers.
  // `abrCodecBlock` holds the codecs this machine failed to decode in real time, keyed by the file they were blocked on; the
  // playback ladder hands their quality slots to another codec. The decoder verdict itself (dropped frames, A/V desync, a
  // stall, with a healthy buffer) is the shared lag detector inside the controller (`stepDecoder`, PLAY-CODEC-01).
  // `userTargetQuality` tracks the user's most recent intentional quality
  // choice (Settings preference, or an OSC pick) — a manual pick pins the rung, Auto climbs only up to the Settings
  // quality. ABR-driven switches do NOT update this ref.
  const [abrCodecBlock, setAbrBlockedCodecs] = useState<{ fileId: string | null; codecs: ReadonlySet<string> }>(
    () => ({ fileId: null, codecs: NO_BLOCKED_CODECS }),
  );
  // The load the lag window belongs to (format + reload stamp): a new load restarts it.
  const abrDecodeKeyRef = useRef<string | null>(null);
  const abrPollCycleRef = useRef(0);
  // Downshift hysteresis clocks (issue #25 P8, N4) live in the controller: when the current load started and showed
  // its first frame (mpv's playback-restart, `firstFrameFrom: "event"`), and when the last reload settled.
  const [abrCtrl] = useState(() => {
    // `netBpsIsSmoothed`: the main-process link meter hands over its own EWMA. `decoderPolicy: "any"`: a computer decodes in
    // software as a normal way to play (PLAY-QUAL-06), so only measured drops, desync or a stall are a decoder verdict.
    const ctrl = createAbrController([], { quality: playbackQuality, force: false }, Date.now(), null, {
      firstFrameFrom: "event",
      netBpsIsSmoothed: true,
      decoderPolicy: "any",
    });
    noteLaunch(ctrl);
    return ctrl;
  });
  // Last held-downshift reason logged, so a hold logs once, not every tick.
  const abrHeldLoggedRef = useRef<DownshiftHeld | null>(null);
  const userTargetQualityRef = useRef<QualityPreset | null>(null);
  // STOR-BW-07 / STOR-BW-08 / PLAY-QUAL-07: the silo's saturation state, read through a ref by the tick.
  const saturation = usePlaybackSaturation();
  const saturationRef = useRef(saturation);
  saturationRef.current = saturation;
  const seenRefusalsRef = useRef(0);
  const seenStopsRef = useRef(0);
  const capRequestedRef = useRef<string | null>(null);
  // A manual quality pick (app menu or OSC video menu) pins the rung: ABR
  // only warns until the user picks Auto again or the file changes.
  // @bugfix @regression-proof issue #25 P19
  const abrManualPinRef = useRef(false);
  // The quality / ABR switch that still has to complete. selectFixedFormat /
  // selectAutoQuality pause mpv and record it here; the init effect reloads
  // (or queues it behind an in-flight load) and settles it on EVERY exit.
  // Replaces the old write-only `abrSwitchInFlightRef`, which latched true
  // and was never cleared on the paths that dropped the switch.
  // @bugfix @regression-proof issue #25 c035 / c065 / s1:x002 — see
  // formatSwitchReload.ts.
  const [formatSwitch] = useState(() => new PendingFormatSwitch());
  const loadInFlight = usePlaybackPhaseSelector(phaseStore, isLoadInFlight);
  // Bumped to re-fire the init effect for a switch queued behind a load.
  const [formatSwitchRetryNonce, setFormatSwitchRetryNonce] = useState(0);
  // Bumped when the init effect queues a switch, so the retry effect below
  // re-checks even if the in-flight window never rendered as `true`.
  const [formatSwitchDeferTick, setFormatSwitchDeferTick] = useState(0);
  useEffect(() => {
    const pending = formatSwitch.get();
    const inFlightNow = isLoadInFlight(phaseRef.current);
    if (!shouldRetryDeferredSwitch({ loadInFlight: inFlightNow, pending })) return;
    formatSwitch.markRetried();
    mpvLog.info({
      switchId: pending?.id,
      source: pending?.source,
      formatId: pending?.formatId,
      deferrals: pending?.deferrals,
      phaseKind: phaseRef.current.kind,
      loadInFlightSelector: loadInFlight,
    }, "format switch: in-flight load settled — re-firing init for the queued switch");
    setFormatSwitchRetryNonce((value) => value + 1);
  }, [formatSwitch, loadInFlight, formatSwitchDeferTick]);
  const forcePlaybackQualityRef = useRef(forcePlaybackQuality);
  useEffect(() => {
    forcePlaybackQualityRef.current = forcePlaybackQuality;
  }, [forcePlaybackQuality]);
  // Indirection ref for selectFixedFormat — the function is declared further
  // down in the hook (it depends on state that hasn't been declared yet at
  // this point in source order), but the ABR poll loop needs to call it. The
  // ref is populated immediately after selectFixedFormat is declared.
  const selectFixedFormatRef = useRef<
    (formatId: string, source?: "user" | "abr") => void
  >(() => undefined);

  const ensurePlaybackBase = useCallback(async () => {
    if (playbackBaseRef.current) return playbackBaseRef.current;
    if (!playbackBasePromiseRef.current) {
      playbackBasePromiseRef.current = window.sf
        ?.getPlaybackBaseUrl?.()
        .then((base) => {
          if (!base) throw new Error("playback_base_missing");
          playbackBaseRef.current = base;
          playbackBasePromiseRef.current = null;
          return base;
        })
        .catch((error) => {
          playbackBasePromiseRef.current = null;
          throw error;
        }) ?? Promise.reject(new Error("playback_base_missing"));
    }
    return await playbackBasePromiseRef.current;
  }, []);

  const getPlaybackObjectUrl = useCallback(
    async (key: string) => {
      const base = await ensurePlaybackBase();
      return `${base}/playback/object/${key}`;
    },
    [ensurePlaybackBase]
  );

  useEffect(() => {
    if (!token) return;
    window.sf?.setPlaybackToken?.(token).catch(() => null);
  }, [token]);

  useEffect(() => {
    if (!mpvFlagsRef.current.externalPlayer) return;
    if (!open) {
      setPlayerReady(false);
      return;
    }
    setPlayerReady(true);
  }, [open]);

  // Engine-local wrappers around the {@link MpvClient} transport. These were
  // previously returned by `useExternalMpvController` and the engine destructured
  // 6+ callbacks; tier-3 task F collapsed that surface so the engine consumes a
  // single `mpvClient` (constructed above) and inlines the gating/polling logic.
  // Behavior preserved: each wrapper still checks the externalPlayer flag and
  // the lifecycle state, and emits `mpv_socket_missing` recovery the same way
  // the controller used to.
  //
  // PR 4.1a + 4.1b + 4.1c: the mpv IPC seam — all 12 helpers including
  // the phase-coupled `ensureExternalSeek` — lives in
  // `useExternalMpvCommands`. The engine destructures the facade once
  // and uses the helpers in-body unchanged.
  //
  // mpv's `time-pos` is movie time: our VOD HLS streams are 0-based, so no
  // timeline offset is inferred or applied anywhere (issue #25 P2).
  const externalMpv = useExternalMpvCommands({
    mpvClient,
    mpvFlagsRef,
    lifecycleRef,
    phaseRef,
    lastKnownTimeRef,
  });
  const {
    sendExternalCommandRaw,
    sendExternalRequestRaw,
    sendExternalCommand,
    sendExternalCommandReply,
    sendExternalRequest,
    sendExternalCommandUnchecked,
    waitForExternalTracksStable,
    waitForVoConfigured,
    waitForMetadataApplied,
    waitForExternalPause,
    confirmExternalPlaybackReady,
    ensureExternalSeek,
  } = externalMpv;

  // PR 4.1c: ensureExternalSeek + ensureExternalSeekIdRef moved to
  // useExternalMpvCommands. The full helper body (with @bugfix tags for
  // mpv-launch-loop-seek-during-launching + mpv-backdrop-handoff-seek-gate +
  // seek-gate-phase-flip) now lives in lib/useExternalMpvCommands.ts.

  const isExternalZeroSeek = useCallback((target: number) => {
    return mpvFlagsRef.current.externalPlayer && target <= ZERO_SEEK_EPS;
  }, []);

  // PR 4.1b: waitForExternalPause moved to useExternalMpvCommands (above).

  const sendPauseCommand = useCallback(
    async (value: boolean) => {
      const sent: SentPause = { value, at: Date.now() };
      lastSentPauseRef.current = sent;
      const ok = await sendExternalCommand(buildSetPropertyCommand("pause", value));
      // mpv replied "success" to set_property, so it holds this value now: a
      // pause clicked a moment later is the user's, even before the 1 s status
      // poll has seen mpv playing (player-pause-resumes-by-itself).
      if (ok && lastSentPauseRef.current === sent) lastSentPauseRef.current = markSentPauseSeen(sent, value);
      return ok;
    },
    [sendExternalCommand]
  );

  useEffect(() => {
    blockAutoPlayRef.current = blockAutoPlay;
    void sendPauseCommand(blockAutoPlay);
  }, [blockAutoPlay, sendPauseCommand]);

  const episode = useMemo(
    () => media.episodes.find((item) => item.id === episodeId) ?? null,
    [media.episodes, episodeId]
  );
  // The overlay's "what's playing" line (PLAY-OVL-01), shown by tog4in1 via force-media-title.
  const nowPlaying = useMemo(() => formatNowPlayingParts(media, episode), [media, episode]);

  const file = useMemo(() => {
    if (media.type === "movie") {
      return media.files[0] ?? null;
    }
    if (episode) {
      return (
        media.files.find(
          (item) => item.season === episode.seasonNumber && item.episode === episode.episodeNumber
        ) ?? null
      );
    }
    return media.files[0] ?? null;
  }, [media, episode]);
  const fileId = file?.id ?? null;
  // A codec block belongs to the file it was raised on; another file starts clean.
  const abrBlockedCodecs = abrCodecBlock.fileId === fileId ? abrCodecBlock.codecs : NO_BLOCKED_CODECS;
  const formats = useMemo(
    () => buildPlaybackFormatsForFile(media.formats, fileId, abrBlockedCodecs),
    [media.formats, fileId, abrBlockedCodecs],
  );
  // What the decode fallback rebuilds the ladder from (library rows, file,
  // codec block). Synced after commit, so render stays ref-free; declared
  // before the ABR loop that reads it so the compiler sees a ref.
  const abrLadderInputsRef = useRef({ libraryFormats: media.formats, fileId, blockedCodecs: abrBlockedCodecs });
  useEffect(() => {
    abrLadderInputsRef.current = { libraryFormats: media.formats, fileId, blockedCodecs: abrBlockedCodecs };
  }, [media.formats, fileId, abrBlockedCodecs]);

  // MPV-PREV-01: the playing file's seek-bar preview record, handed to the main process with every metadata send.
  // MPV-PREV-04: read from the library's latest formats, not the launch snapshot, so sheets the runtime records while
  // the video plays (an import decodes them after the commit) reach the open player.
  const latestFormats = libraryFormats ?? media.formats;
  const previewSheets = useMemo(() => sourcePreviewSheets(latestFormats, fileId), [latestFormats, fileId]);
  // MPV-PREV-06: with no record, the source format and the "Previews are being prepared" text for the seek bar.
  const missingPreviews = useMemo(
    () => missingPreviewsFor(latestFormats, fileId, t("player.previewsPreparing")),
    [latestFormats, fileId, t]
  );
  // The one place that calls the main process with the record.
  const previewSheetsHandoff = useMemo(
    () =>
      createPreviewSheetsHandoff({
        deliver: ({ record, missing }) => window.sf?.setExternalMpvPreviewSheets?.(record, missing),
        log: (line, data) => subPipelineLog.info(data, line),
      }),
    [],
  );

  const formatSupport = useMemo(() => {
    const support = new Map<string, boolean>();
    formats.forEach((format) => support.set(format.id, true));
    return support;
  }, [formats]);

  const [selectedFormatId, setSelectedFormatId] = useState<string | null>(null);
  const [qualityMode, setQualityMode] = useState<"auto" | "fixed">("fixed");
  const [audioOptions, setAudioOptions] = useState<AudioOption[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);
  // Tracks picked in the mpv OSC (sf-select.lua → `sf-track-picked`), carried
  // on every reload of the same file. @bugfix @regression-proof issue #25 P18
  const oscTrackPicksRef = useRef(new OscTrackPicks());
  const fileIdRef = useRef(fileId);
  fileIdRef.current = fileId;
  // The media/episode progress is saved for right now: a poll tick started
  // for another target must not save (issue #25 NEW-resume-wrong-episode).
  const progressTargetRef = useRef<ProgressSaveTarget>({ mediaId: media.id, episodeId: episodeId ?? null });
  progressTargetRef.current = { mediaId: media.id, episodeId: episodeId ?? null };

  const playbackState = useMemo(
    () =>
      buildMpvPlaybackState({
        formats,
        playbackQuality,
        selectedFormatId,
        qualityMode,
        audioOptions,
        selectedAudioId,
      }),
    [audioOptions, formats, playbackQuality, qualityMode, selectedAudioId, selectedFormatId]
  );
  const {
    selectedFormat,
    autoFormat,
    effectiveFormat,
    effectiveFormatId,
    effectiveFormatMap,
    effectiveFormatSignature,
    audioMap,
    audioMapSignature,
    initSignature,
  } = playbackState;
  const hasPlayableAudio = useMemo(
    () => hasPlayableAudioTrack(media.audioTracks, episode?.id ?? null),
    [episode?.id, media.audioTracks]
  );

  useEffect(() => {
    if (formats.length === 0) {
      setSelectedFormatId(null);
      return;
    }
    if (selectedFormatId && formats.some((format) => format.id === selectedFormatId)) {
      return;
    }
    // selectedFormatId is unset or no longer valid (typically a next-episode
    // transition — the new episode's formats have different ids). Product rule:
    // a NEW episode always aims for the configured playbackQuality (Settings
    // default), regardless of the previous episode. We do NOT carry the previous
    // stream's ABR-reached quality (it drains to the lowest tier near EOF, which
    // pinned every auto-advanced episode at 360p — the reported bug), and we do
    // NOT carry a one-off explicit pick from the previous episode (an episode the
    // user bumped to 4K must still revert to 1080p if Settings say 1080p). The
    // userTargetQualityRef clear on fileId change (below) reverts the ABR ceiling
    // to playbackQuality too, so ABR can't climb the new episode back up.
    // @bugfix next-episode-quality-reset @bugfix next-episode-360p-abr-transient-carry
    const nextId = resolveNextEpisodeFormatId({
      // Both prior-quality inputs are passed but deliberately ignored by the
      // resolver (it targets playbackQuality). Passed real/null so the contract
      // stays explicit; the unit test injects poisoned values to prove neither
      // leaks through.
      userTargetQuality: userTargetQualityRef.current,
      priorEffectiveQuality: null,
      playbackQuality,
      formats,
    });
    if (nextId) {
      setSelectedFormatId(nextId);
    }
  }, [formats, selectedFormatId, playbackQuality]);

  // A new episode/file starts from a clean quality slate: clear any one-off
  // explicit quality pick from the previous episode so BOTH the carry above and
  // ABR's ceiling (`targetMaxQuality = userTargetQualityRef ?? playbackQuality`)
  // revert to the Settings default. Without this, ABR would re-climb the new
  // episode up to the previous episode's manual pick (e.g. back to 4K) even
  // though the carry started it at the Settings 1080p. fileId is stable across
  // same-episode quality reloads (those bump playerSession, not fileId), so an
  // in-episode pick still persists for the rest of that episode.
  // @bugfix next-episode-360p-abr-transient-carry
  // The new file also starts with no decode bans, no decode ceiling and no "too weak" notice yet: they describe the previous
  // file (PLAY-CODEC-02 is per file). Codec blocks are keyed by file (see `abrBlockedCodecs`).
  useEffect(() => {
    userTargetQualityRef.current = null;
    abrManualPinRef.current = false;
    abrCtrl.quality = { ...abrCtrl.quality, bannedIds: [], decodeCeilingRank: null };
    abrCtrl.tooWeakNotified = false;
    resetLagDetector(abrCtrl.lag, Date.now());
  }, [abrCtrl, fileId]);

  const effectiveFormatChunkKeys = effectiveFormat?.chunks?.map((chunk) => chunk.key) ?? [];


  const [subtitleOptions, setSubtitleOptions] = useState<SubtitleOption[]>([]);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string>("off");
  // PLAY-TRACK-07 interim: read by the late sidecar fill, which outlives the render that started it.
  const selectedSubtitleIdRef = useRef(selectedSubtitleId);
  selectedSubtitleIdRef.current = selectedSubtitleId;
  // The launch's background sidecar fill, and the launch payload it must wait for: sf.lua's `start-file` wipes its
  // pending list, and a later launch send would overwrite a list the fill already re-sent.
  const lateSidecarsRef = useRef<LateSubtitleSidecars | null>(null);
  const launchMetadataSentRef = useRef<{ payload: ExternalPlaybackMetadataPayload; resolve: () => void } | null>(null);
  // "off" is both the unset seed (the resolver then falls through to the default
  // track) and the user's choice; this tells them apart so a picked Off holds
  // (@bugfix #25 Orchard: one default French subtitle, Off was flipped back on).
  const [subtitlesOffPicked, setSubtitlesOffPicked] = useState(false);
  const [pgsTimeOffset, setPgsTimeOffset] = useState(0);
  useEffect(() => {
    const next = resolvePlaybackAudioState({
      audioTracks: media.audioTracks,
      preferredAudioLanguage: trackPrefs?.audioLanguage ?? null,
      episodeId: episode?.id ?? null,
      selectedAudioId,
    });
    setAudioOptions((prev) => {
      const prevKey = prev.map((o) => o.id).join(",");
      const nextKey = next.options.map((o) => o.id).join(",");
      return prevKey === nextKey ? prev : next.options;
    });
    if (next.selectedAudioId !== selectedAudioId) {
      setSelectedAudioId(next.selectedAudioId);
    }
  }, [episode, media.audioTracks, selectedAudioId, trackPrefs?.audioLanguage]);

  useEffect(() => {
    const next = resolvePlaybackSubtitleState({
      subtitleTracks: media.subtitleTracks,
      episodeId: episode?.id ?? null,
      selectedSubtitleId,
      subtitlesOffPicked,
      subtitlesOffLabel: t("player.subtitlesOff"),
    });
    setSubtitleOptions((prev) => {
      const prevKey = prev.map((o) => o.id).join(",");
      const nextKey = next.options.map((o) => o.id).join(",");
      return prevKey === nextKey ? prev : next.options;
    });
    if (next.selectedSubtitleId !== selectedSubtitleId) {
      setSelectedSubtitleId(next.selectedSubtitleId);
    }
  }, [episode, media.subtitleTracks, selectedSubtitleId, subtitlesOffPicked, t]);

  // PLAY-SUBGET-02: a subtitle stored from the mpv menu's "Get more subtitles…" row, switched on once the
  // refreshed media lists it (the effect next to setSelectedSubtitle below). PLAY-SUBGET-07: after "Try another
  // version" the same, skipping the replaced track should the media still list it.
  const fetchedSubtitleRef = useRef<{ episodeId: string | null; language: string; label: string; replacedId?: string } | null>(null);
  const [fetchedSubtitleTick, setFetchedSubtitleTick] = useState(0);
  const selectedLibrarySubtitle = useMemo(
    () => media.subtitleTracks.find((track) => track.id === selectedSubtitleId) ?? null,
    [media.subtitleTracks, selectedSubtitleId]
  );
  const { getMoreSubtitlesLabel, tryAnotherVersionLabel, addSubtitleFileLabel } = useMpvSubtitleFetch({
    open,
    isExternalPlayer: () => mpvFlagsRef.current.externalPlayer,
    media,
    episodeId: episodeId ?? null,
    token,
    addSubtitleTrack,
    removeSubtitleTrack,
    getMediaObjectKeys,
    selectedSubtitle: selectedLibrarySubtitle,
    setTrackPrefs,
    sendExternalCommand,
    sendPauseCommand,
    subtitlesOffLabel: t("player.subtitlesOff"),
    onAdded: (entry, addedEpisodeId) => {
      fetchedSubtitleRef.current = { episodeId: addedEpisodeId, language: entry.language, label: entry.trackName };
      setFetchedSubtitleTick((tick) => tick + 1);
    },
    // PLAY-SUBGET-23: the added file is switched on the same way once the media lists it.
    onFileAdded: (stored, addedEpisodeId) => {
      fetchedSubtitleRef.current = { episodeId: addedEpisodeId, language: stored.language, label: stored.label };
      setFetchedSubtitleTick((tick) => tick + 1);
    },
    onReplaced: async (replaced, replacedEpisodeId) => {
      // mpv still holds the old file under the same name and language: drop it, or the menu lists the name twice
      // and the apply effect would reuse it (findExternalSubtitle matches by title + language).
      const trackListResult = await getProperty(sendExternalRequest, "track-list");
      const trackList: ReadonlyArray<MpvTrack> = Array.isArray(trackListResult) ? trackListResult : [];
      const title = formatPlayerTrackLabel(replaced.language, replaced.label, "Subtitle");
      const lang = replaced.language || "und";
      const stale = trackList.filter((track) => track?.type === "sub" && track.title === title && track.lang === lang);
      for (const track of stale) {
        if (typeof track.id === "number") await sendExternalCommand(buildSubRemoveCommand(track.id));
      }
      mpvSubtitleLog.info({ trackId: replaced.id, removedSids: stale.map((track) => track.id) }, "try another version: old file dropped from mpv");
      fetchedSubtitleRef.current = {
        episodeId: replacedEpisodeId,
        language: replaced.language,
        label: replaced.label,
        replacedId: replaced.id,
      };
      setFetchedSubtitleTick((tick) => tick + 1);
    },
  });
  // Read by the launch payload without being one of its deps: switching subtitles must not rebuild loadStream (whose
  // identity change reloads the stream); a change mid-playback is re-sent by useMpvSubtitleFetch.
  const tryAnotherVersionLabelRef = useRef(tryAnotherVersionLabel);
  const addSubtitleFileLabelRef = useRef(addSubtitleFileLabel);
  useEffect(() => {
    tryAnotherVersionLabelRef.current = tryAnotherVersionLabel;
    addSubtitleFileLabelRef.current = addSubtitleFileLabel;
  }, [tryAnotherVersionLabel, addSubtitleFileLabel]);

  // The rungs the HLS master lists, in its order (createHlsSession drops a
  // format without a chunk map): the vid ↔ format mapping ranks ties here.
  const hlsMasterFormats = useMemo(
    () => formats.filter((format) => buildChunkMapFromFormat(format) !== null),
    [formats],
  );
  // @bugfix @regression-proof issue #25 P18: a track picked in the OSC must
  // survive a quality / ABR reload. Record it per file (loadStream carries it
  // as the reload's per-load aid/sid) and map a subtitle pick back into
  // selectedSubtitleId so the reload's metadata payload re-selects it.
  useEffect(() => {
    if (!open) {
      oscTrackPicksRef.current.reset();
      return;
    }
    if (!mpvFlagsRef.current.externalPlayer) return;
    const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
      const pick = parseTrackPickedMessage(msg);
      if (!pick) return;
      const pickFileId = fileIdRef.current;
      // @bugfix @regression-proof issue #25 P19 (c004): a video pick is a
      // quality pick. Switch to its format as a manual ("user") pick — that
      // pins the rung against ABR, and a newer switch request supersedes an
      // ABR switch still reloading (PendingFormatSwitch: latest wins).
      if (pick.property === "vid") {
        if (pick.value === "no") {
          mpvLog.info({ fileId: pickFileId }, "osc video pick turned video off — not a quality pick");
          return;
        }
        const vid = pick.value;
        void (async () => {
          const trackListResult = await getProperty(sendExternalRequest, "track-list");
          const trackList: ReadonlyArray<MpvTrack> = Array.isArray(trackListResult) ? trackListResult : [];
          const formatId = resolvePickedVideoFormatId({ vid, trackList, formats: hlsMasterFormats });
          if (fileIdRef.current !== pickFileId) return;
          if (formatId === null) {
            mpvLog.warn({ vid, fileId: pickFileId, videoTracks: trackList.filter((track) => track?.type === "video") }, "osc video pick matches no format — ABR keeps the rung");
            return;
          }
          mpvLog.info({ vid, formatId, fileId: pickFileId }, "osc video pick → manual format switch (ABR pinned)");
          selectFixedFormatRef.current(formatId, "user");
        })().catch((error: unknown) => {
          mpvLog.warn(
            { vid, error: error instanceof Error ? error.message : String(error) },
            "osc video pick: track-list read failed — ABR keeps the rung",
          );
        });
        return;
      }
      oscTrackPicksRef.current.record(pickFileId, pick);
      mpvLog.info({ property: pick.property, value: pick.value, fileId: pickFileId }, "osc track pick recorded (carried on reloads)");
      // PLAY-TRACK-04: every pick is the movie's / show's new remembered choice.
      const rememberPick = async (trackList: ReadonlyArray<MpvTrack>, subtitleOptionId: string | null) => {
        const patch = trackPrefsPatchForPick({ pick, trackList, subtitleOptions, subtitleOptionId });
        if (!patch) {
          mpvLog.info({ property: pick.property, value: pick.value, fileId: pickFileId }, "osc pick has no durable track preference (unknown language)");
          return;
        }
        const mediaId = progressTargetRef.current.mediaId;
        mpvLog.info({ mediaId, patch, fileId: pickFileId }, "osc pick remembered as the media's track preference");
        try {
          await setTrackPrefsRef.current(mediaId, patch);
        } catch (error) {
          mpvLog.warn({ mediaId, patch, error: error instanceof Error ? error.message : String(error) }, "osc pick: saving the track preference failed");
        }
      };
      void (async () => {
        const trackListResult = pick.value === "no" ? [] : await getProperty(sendExternalRequest, "track-list");
        const trackList: ReadonlyArray<MpvTrack> = Array.isArray(trackListResult) ? trackListResult : [];
        const optionId = pick.property === "sid" ? resolvePickedSubtitleOptionId({ sid: pick.value, trackList, subtitleOptions }) : null;
        if (fileIdRef.current !== pickFileId) return;
        void rememberPick(trackList, optionId);
        if (pick.property !== "sid") return;
        if (optionId === null) {
          mpvLog.info({ sid: pick.value, fileId: pickFileId }, "osc subtitle pick has no app subtitle option; reloads carry the raw sid");
          return;
        }
        oscTrackPicksRef.current.subtitleMappedToOption(pickFileId);
        mpvLog.info({ sid: pick.value, subtitleId: optionId, fileId: pickFileId }, "osc subtitle pick mapped to selectedSubtitleId");
        setSubtitlesOffPicked(optionId === "off");
        setSelectedSubtitleId(optionId);
      })().catch((error: unknown) => {
        mpvLog.warn(
          { property: pick.property, value: pick.value, error: error instanceof Error ? error.message : String(error) },
          "osc pick: track-list read failed; reloads carry the raw pick",
        );
      });
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [hlsMasterFormats, open, sendExternalRequest, subtitleOptions]);

  // @bugfix @regression-proof issue #25 P1b (S1 c055): an OSC seekbar seek
  // happens inside mpv, and mpv reports the pre-seek time-pos until it
  // lands. The OSC announces the target (`sf-osc-seek`); treat it like an
  // app seek so a reload started meanwhile resumes there, not at 0.
  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer) return;
    const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
      const target = parseOscSeekMessage(msg);
      if (target === null) return;
      const loadInFlight = pendingStart.isLoadInFlight();
      seekTargetRef.current = target;
      noteSeek(abrCtrl, Date.now());
      lastKnownTimeRef.current = target;
      const armed = pendingStart.userSeek(target);
      mpvLog.info({ target, armed, loadInFlight }, "osc seek announced — carried as the pending start target");
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [open, pendingStart]);

  // The app's own audio choice wins over an earlier OSC pick (P18). Cleared on
  // a selectedAudioId change rather than inside setSelectedAudio, whose exact
  // `useCallback(..., [])` shape is pinned by the 1f6081e8 source guards.
  // OSC picks never write selectedAudioId, so only app choices reach here.
  useEffect(() => {
    oscTrackPicksRef.current.clearAudio();
  }, [selectedAudioId]);
  // PLAY-TRACK-04: the mpv `aid` of the app's audio choice in the HLS master (null when it is not listed). Read by
  // loadStream for the per-load `aid` and by the apply effect below.
  const appAudioTrackRef = useRef<number | null>(null);
  useEffect(() => {
    appAudioTrackRef.current = hlsAudioTrackFor(audioOptions, selectedAudioId);
  }, [audioOptions, selectedAudioId]);

  const effectiveFormatMapRef = useRef<ChunkMap | null>(null);
  const audioMapRef = useRef<ChunkMap | null>(null);

  useEffect(() => {
    effectiveFormatMapRef.current = effectiveFormatMap;
  }, [effectiveFormatMap]);

  useEffect(() => {
    audioMapRef.current = audioMap;
  }, [audioMap]);

  const chapters = useMemo(
    () =>
      buildPlaybackChapters({
        chapters: media.chapters,
        fileId,
        formats,
        effectiveFormatId,
      }),
    [effectiveFormatId, fileId, formats, media.chapters]
  );

  const currentSkipMarkers = useMemo(
    () => buildPlaybackSkipMarkers(media.skipMarkers, episode?.id ?? null),
    [episode, media.skipMarkers]
  );
  // Start of the credits marker, read by the long-lived poll's premature-EOF
  // check: a jump to the end from inside the credits is the user's skip
  // (issue #25 P6). Written during render like selectFixedFormatRef below.
  const creditsStartRef = useRef<number | null>(null);
  creditsStartRef.current = currentSkipMarkers.find((marker) => marker.type === "credits")?.startSeconds ?? null;

  const buildExternalMetadataPayload = useCallback(async () => {
    if (!mpvFlagsRef.current.externalPlayer) {
      return buildExternalPlaybackMetadataPayload({
        subtitles: [],
        chapters: [],
        audioOptions: [],
        subtitlesOffLabel: t("player.subtitlesOff"),
        menuPrompts: oscMenuPrompts(t),
        skipMarkers: [],
        title: nowPlaying.title,
        meta: nowPlaying.meta,
        previousEpisode: null,
        nextEpisode: null,
        autoplayNextEpisode,
        autoSkipIntro,
        autoSkipCredits,
      });
    }
    // OCR twins (PLAY-TRACK-05) only stand in for picture tracks on the Android TV's direct rendering; mpv here
    // draws the pictures, so twins never reach its track list.
    const subtitleTracks = media.subtitleTracks.filter((track) =>
      (episode ? track.episodeId === episode.id : !track.episodeId) && !isOcrTwin(track)
    );
    subPipelineLog.info({
      mediaId: media.id,
      episodeId: episode?.id ?? null,
      allTracks: media.subtitleTracks.length,
      filteredTracks: subtitleTracks.length,
      trackSummary: subtitleTracks.map((t) => ({
        id: t.id,
        lang: t.language,
        label: t.label,
        hasObjectKey: Boolean(t.objectKey),
        format: t.format ?? null,
      })),
    }, "build payload: begin");
    // Which track each resolved URL is: the late sidecar fill selects a landed sidecar only if it is still the pick.
    const trackIdByUrl = new Map<string, string>();
    const subtitlePayload = (
      await Promise.all(
        subtitleTracks
          // Offline source: only the subtitles saved with the item (the others would need the network).
          .filter((track) => track.objectKey && (offlineSubtitleKeysRef.current?.has(track.objectKey) ?? true))
          .map(async (track) => {
            const url = await getPlaybackObjectUrl(track.objectKey as string);
            if (!url) {
              subPipelineLog.warn({ objectKey: track.objectKey, label: track.label, lang: track.language }, "subtitle URL resolved to empty");
            }
            if (url) trackIdByUrl.set(url, track.id);
            // `selected` is set on the user's chosen subtitle (per-session or
            // DB default) so sf.lua can sub-add with mpv's "select" flag and
            // sid is fixed BEFORE the first video frame is decoded. Without
            // this, the renderer's post-launch `set_property sid` triggers a
            // refresh-seek that replays 1–4s of video.
            // Read through the ref: this callback is not rebuilt when the pick changes, so a payload rebuilt
            // mid-launch (skip markers, preview sheets) used to send the start pick as "auto" from a stale
            // closure; sf.lua then deduped the late fill's "select" and mpv kept sid=no (release gate 34595).
            const pick = selectedSubtitleIdRef.current;
            const isSelected = pick !== "off" && pick === track.id;
            return {
              url,
              // Pre-format the subtitle title as "Lang - descriptor" (or just
              // "Lang", or verbatim label for und). mpv stores this on the
              // track via sub-add, and sf-select displays track.title.
              title: formatPlayerTrackLabel(track.language, track.label, "Subtitle"),
              lang: track.language || "und",
              format: track.format ?? null,
              selected: isSelected,
            };
          })
      )
    ).filter((entry) => entry.url);
    subPipelineLog.info({
      subtitlePayload: subtitlePayload.map((s) => ({ url: s.url, lang: s.lang, format: s.format, selected: s.selected })),
    }, "build payload: urls resolved");
    // PLAY-TRACK-07 interim (MPV-SUBLATE-001): launch never waits on a subtitle download, and mpv never gets a raw
    // proxy URL for a sidecar. mpv reads an external subtitle up to the playing moment before it shows the next
    // frame, so a raw URL holds the picture while the file streams (a 30 MB PGS track resumed late in the film froze
    // the bundled mpv ~2 s with 50 dropped frames; from disk it adds in 3 ms with no drop). The launch payload holds
    // the sidecars already on disk; the others are fetched in the background and sent to sf.lua as each lands. A
    // failed fetch only logs: a remembered subtitle at start is not a pick (PLAY-TRACK-06).
    // Supersedes @bugfix mpv-window-hide-delay-uncapped-subtitle-cache (the 3 s race with a raw-URL fallback).
    lateSidecarsRef.current?.cancel();
    lateSidecarsRef.current = null;
    let launchSubtitles: SubtitleSidecar[] = subtitlePayload;
    let pendingSubtitles: SubtitleSidecar[] = [];
    const subtitleCacheStartMs = Date.now();
    const cacheBridge = window.sf?.cacheExternalMpvSubtitles;
    const cache: SubtitleSidecarCache | null = cacheBridge
      ? (entries, options) => cacheBridge(entries, options)
      : null;
    if (cache) {
      const split = await splitLaunchSidecars(subtitlePayload, cache);
      launchSubtitles = split.ready;
      pendingSubtitles = split.pending;
      subPipelineLog.info({
        elapsedMs: Date.now() - subtitleCacheStartMs,
        input: subtitlePayload.length,
        onDisk: launchSubtitles.length,
        pending: pendingSubtitles.map((s) => ({ url: s.url, lang: s.lang, selected: s.selected ?? false })),
      }, "build payload: launch sidecars split (no download wait)");
    }
    subPipelineLog.info({
      launchSubtitles: launchSubtitles.map((s) => ({ url: s.url, lang: s.lang })),
      launch: launchSubtitles.length,
      input: subtitlePayload.length,
      cacheAvailable: Boolean(cache),
    }, "build payload: cached");
    playbackDebugLog.debug({
      audioOptions: audioOptions.length,
      audioLabels: audioOptions.map((o) => o.label),
      subtitleTracksTotal: media.subtitleTracks.length,
      subtitleTracksFiltered: subtitleTracks.length,
      subtitleUrlsResolved: subtitlePayload.length,
      subtitlesAtLaunch: launchSubtitles.length,
    }, "buildExternalMetadataPayload");
    const payload = buildExternalPlaybackMetadataPayload({
      subtitles: launchSubtitles,
      chapters,
      audioOptions,
      subtitlesOffLabel: t("player.subtitlesOff"),
      getMoreSubtitlesLabel,
      tryAnotherVersionLabel: tryAnotherVersionLabelRef.current,
      addSubtitleFileLabel: addSubtitleFileLabelRef.current,
      menuPrompts: oscMenuPrompts(t),
      skipMarkers: currentSkipMarkers,
      title: nowPlaying.title,
      meta: nowPlaying.meta,
      previousEpisode: previousEpisode ?? null,
      nextEpisode: nextEpisode ?? null,
      autoplayNextEpisode,
      autoSkipIntro,
      autoSkipCredits,
    });
    if (cache && pendingSubtitles.length > 0) {
      const launchSent = Promise.withResolvers<void>();
      launchMetadataSentRef.current = { payload, resolve: launchSent.resolve };
      lateSidecarsRef.current = fillLateSidecars({
        ready: launchSubtitles,
        pending: pendingSubtitles,
        cache,
        stillSelected: (entry) => selectedSubtitleIdRef.current === trackIdByUrl.get(entry.url),
        isCurrent: () => mpvFlagsRef.current.externalPlayer,
        send: async (list) => {
          await launchSent.promise;
          if (!isExternalActive(lifecycleRef.current)) {
            subPipelineLog.info({ count: list.length }, "late sidecars: skip send (no active session)");
            return;
          }
          const result = await sendExternalCommand(buildScriptMessageCommand(LUA_CHANNELS.SUBTITLES_JSON, list));
          subPipelineLog.info({ count: list.length, result }, "late sidecars: list re-sent to sf.lua");
        },
        log: subPipelineLog,
      });
    }
    return payload;
  }, [
    audioOptions,
    autoplayNextEpisode,
    autoSkipCredits,
    autoSkipIntro,
    chapters,
    currentSkipMarkers,
    episode,
    getMoreSubtitlesLabel,
    getPlaybackObjectUrl,
    media.subtitleTracks,
    nextEpisode,
    nowPlaying,
    previousEpisode,
    sendExternalCommand,
    t,
  ]);

  // Opens the late sidecar fill's gate once the payload it extends has reached sf.lua (PLAY-TRACK-07 interim).
  const markLaunchMetadataSent = useCallback((resolved: ExternalPlaybackMetadataPayload) => {
    const pending = launchMetadataSentRef.current;
    if (pending?.payload !== resolved) return;
    launchMetadataSentRef.current = null;
    subPipelineLog.info({ subtitleCount: resolved.subtitles.length }, "late sidecars: launch payload sent, gate open");
    pending.resolve();
  }, []);

  const sendExternalMetadata = useCallback(
    async (payload?: ExternalPlaybackMetadataPayload) => {
      if (!mpvFlagsRef.current.externalPlayer || !isExternalActive(lifecycleRef.current)) {
        return;
      }
      const resolved = payload ?? (await buildExternalMetadataPayload());
      for (const command of buildExternalMetadataCommands(resolved)) {
        await sendExternalCommand(command);
      }
      markLaunchMetadataSent(resolved);
    },
    [buildExternalMetadataPayload, markLaunchMetadataSent, sendExternalCommand]
  );

  // PR 4.1b: sendExternalCommandUnchecked moved to useExternalMpvCommands.

  const sendExternalMetadataUnchecked = useCallback(
    async (payload?: ExternalPlaybackMetadataPayload): Promise<{ sent: number; failed: number; socketMissing: boolean }> => {
      if (!mpvFlagsRef.current.externalPlayer) return { sent: 0, failed: 0, socketMissing: false };
      // Skip entirely if mpv was already torn down — sending here would be
      // guaranteed to produce mpv_socket_missing errors for every command,
      // which during a stop+restart cycle creates spurious warning noise.
      if (!isExternalActive(lifecycleRef.current)) {
        subPipelineLog.debug({}, "sendMetadata: skip (no active session)");
        return { sent: 0, failed: 0, socketMissing: true };
      }
      const resolved = payload ?? (await buildExternalMetadataPayload());
      // Not a script-message: the main process keeps the record, answers the OSC's hover requests and tells it
      // whether this video has pictures (MPV-PREV-01), or that they are being prepared (MPV-PREV-06).
      previewSheetsHandoff.send({ record: previewSheets, missing: missingPreviews });
      const commands = buildExternalMetadataCommands(resolved);
      subPipelineLog.info({
        totalCommands: commands.length,
        hasSubtitles: resolved.subtitles.length > 0,
        subtitleCount: resolved.subtitles.length,
        commandTypes: commands.map((c) => {
          const arr = (c as { command: unknown[] }).command;
          return arr[1] ?? String(arr[0]);
        }),
      }, "sendMetadata: begin");
      const outcome = await sendMetadataBatch(
        commands,
        sendExternalCommandUnchecked,
        () => isExternalActive(lifecycleRef.current),
        { subPipeline: subPipelineLog, playbackDebug: playbackDebugLog },
      );
      markLaunchMetadataSent(resolved);
      return outcome;
    },
    [buildExternalMetadataPayload, markLaunchMetadataSent, missingPreviews, previewSheets, previewSheetsHandoff, sendExternalCommandUnchecked]
  );

  // Skip markers can land post-launch via MediaPlaybackController's lazy fetch
  // (especially common for the auto-loaded next episode, whose markers fetch
  // races with the new mpv launch). Without re-sending, the envelope mpv saw
  // at launch had empty markers and the intro pill never fires.
  //
  // GUARD: gate on the SERIALIZED content of currentSkipMarkers, not its
  // array identity. The useMemo that produces `currentSkipMarkers` returns a
  // fresh array on every parent re-render (whenever `media.skipMarkers` ref
  // changes — and the parent re-renders for many reasons unrelated to skip
  // data). Without this guard, the user's mpv log showed 5+ identical
  // envelopes within 50ms, each triggering an `apply_playback_json` that
  // reassigned playback_state.markers and stomped on in-flight pill state.
  // sendExternalMetadataUnchecked is a no-op when mpv is not active so the
  // initial-mount call is safe.
  const lastSentSkipMarkersHashRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isExternalActive(lifecycleRef.current)) return;
    const hash = JSON.stringify(currentSkipMarkers);
    if (hash === lastSentSkipMarkersHashRef.current) return;
    lastSentSkipMarkersHashRef.current = hash;
    void sendExternalMetadataUnchecked();
  }, [currentSkipMarkers, sendExternalMetadataUnchecked]);

  // MPV-PREV-04: the runtime recorded this file's preview sheets (or replaced them) while it plays: hand them over now
  // rather than at the next metadata send, which may never come before the video ends.
  useEffect(() => {
    if (!isExternalActive(lifecycleRef.current)) return;
    previewSheetsHandoff.sendIfChanged({ record: previewSheets, missing: missingPreviews });
  }, [missingPreviews, previewSheets, previewSheetsHandoff]);

  // PR 4.1b: confirmExternalPlaybackReady moved to useExternalMpvCommands.

  // `auto`: the app's own play (start, handoff, seek, retry). MPV-PAUSE-01:
  // it never undoes a user pause made since the last explicit play request.
  const resumeExternalPlayback = useCallback(async (options?: { auto?: boolean }) => {
    if (!mpvFlagsRef.current.externalPlayer || !isExternalActive(lifecycleRef.current)) {
      return false;
    }
    if (
      options?.auto &&
      !autoPlayAllowed({ playRequestedAt: playRequestedAtRef.current, userPausedAt: userPausedAtRef.current })
    ) {
      mpvLog.info(
        { playRequestedAt: playRequestedAtRef.current, userPausedAt: userPausedAtRef.current },
        "auto-play skipped: user paused",
      );
      return false;
    }
    const sent: SentPause = { value: false, at: Date.now() };
    lastSentPauseRef.current = sent;
    const resumed = await sendExternalCommand(buildSetPropertyCommand("pause", false));
    if (resumed && (await waitForExternalPause(false))) {
      // mpv played: a pause from here on is the user's (player-pause-resumes-by-itself).
      if (lastSentPauseRef.current === sent) lastSentPauseRef.current = markSentPauseSeen(sent, false);
      return true;
    }
    await sendExternalCommandUnchecked(buildSetPropertyCommand("pause", false));
    return await waitForExternalPause(false);
  }, [sendExternalCommand, sendExternalCommandUnchecked, waitForExternalPause]);

  const [streamError, setStreamError] = useState<string | null>(null);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // One failure path for every load (init effect, Start Over relaunch, format
  // reload): the phase leaves launching, a pending format switch settles, and
  // the user sees why (playbackLoadFailure.ts). `surface=false` when the init
  // effect was cancelled by a re-render.
  const reportLoadFailure = useCallback((error: unknown, source: string, surface = true) => {
    // A load ended by a stop is not a failure: log it quietly, no message.
    const stopped = isPlaybackLoadStopped(error);
    const log = stopped ? mpvLog.info.bind(mpvLog) : mpvLog.warn.bind(mpvLog);
    log({ error: String(error), source }, stopped ? "load ended by a stop" : "load failed");
    // Idempotent w.r.t. loadStream's launch-branch catch: a duplicate
    // load_failed in idle is a no-op.
    dispatchPhase({ type: "load_failed" });
    const failedSwitch = formatSwitch.settle();
    if (failedSwitch) {
      log({
        switchId: failedSwitch.id,
        source: failedSwitch.source,
        formatId: failedSwitch.formatId,
        reason: "load-failed" satisfies FormatSwitchSettleReason,
      }, "format switch: settled by a failed load");
    }
    const messageKey = playbackLoadFailureKey(error);
    if (surface && messageKey) {
      // Offline-aware messaging. @bugfix offline-playback-silent-bounce-when-unreachable
      setStreamError(t(messageKey));
    }
  }, [dispatchPhase, formatSwitch, t]);

  // STOR-BW-07 / STOR-BW-08: a refused or stopped playback ends here, with the reason; the dialogs come from the host.
  // Nothing resumes by itself: the user presses play again once the silo lifted.
  useEffect(() => {
    const refused = saturation.refusals > seenRefusalsRef.current;
    const stopped = saturation.stops > seenStopsRef.current;
    seenRefusalsRef.current = saturation.refusals;
    seenStopsRef.current = saturation.stops;
    if (!open) return;
    if (stopped) setStreamError(t("player.errors.highTrafficStopped"));
    else if (refused) setStreamError(t("player.errors.highTrafficRefused"));
  }, [open, saturation.refusals, saturation.stops, t]);
  // PR 3.2e: `isReadyToReveal` is now derived from the phase store
  // (declared at the top of the hook). `isReadyToRevealRef` is gone —
  // the seek gate reads `seeksAllowed(phaseRef.current)` (PR 3.2d) and
  // the public reveal value re-renders via `usePlaybackPhase`.
  // @bugfix mpv-launch-loop-seek-during-launching (now phase-resolved)
  // @bugfix mpv-backdrop-handoff-seek-gate (now phase-resolved)
  const [appendProgress, setAppendProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedTime, setBufferedTime] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playerSession, setPlayerSession] = useState(0);
  const bufferingTimerRef = useRef<number | null>(null);
  const bufferingHoldUntilRef = useRef(0);
  const manualStateUntilRef = useRef(0);
  const startupHoldUntilRef = useRef(0);
  const userPausedRef = useRef(false);
  const lastSentPauseRef = useRef<SentPause | null>(null);
  // MPV-PAUSE-01 (player-pause-resumes-by-itself): when the user last paused
  // and last asked to play. A pause made in mpv itself (OSC, click on the
  // picture, Space) is caught from mpv's pause reports.
  const userPausedAtRef = useRef<number | null>(null);
  const playRequestedAtRef = useRef(0);
  const lastReportedPauseRef = useRef<boolean | null>(null);
  // `eof`: mpv's `eof-reached` from the same read. keep-open's own pause at the
  // end of the file is not the user's (it would block the premature-EOF
  // recovery's play).
  const noteMpvPause = (next: unknown, eof: unknown) => {
    const previous = lastReportedPauseRef.current;
    if (typeof next === "boolean") lastReportedPauseRef.current = next;
    if (isUserPause({ previous, next, eof, lastSentPause: lastSentPauseRef.current, now: Date.now() })) {
      userPausedRef.current = true;
      userPausedAtRef.current = Date.now();
      mpvLog.info("user paused in mpv — automatic play is off until the next play request");
    } else if (previous === false && next === true && eof === true) {
      mpvLog.info("mpv paused at the end of the file (keep-open) — not a user pause");
    }
  };
  const notePlayRequest = () => {
    playRequestedAtRef.current = Date.now();
  };
  const noteUserPause = () => {
    userPausedAtRef.current = Date.now();
  };
  // PR 3.2b-flip: `skipExternalInitRef` was subsumed by `phase.lastConsumedIntent`
  // (the "userZeroSeek" value covers both the manualStart and skipExternalInit
  // gates; consumed by the init effect's externalPlayer+active branch).

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const fallbackDuration = useMemo(() => {
    const values = formats
      .map((format) => format.durationSeconds)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    return values.length > 0 ? Math.max(...values) : 0;
  }, [formats]);

  // Saves this target's place: where mpv was last polled, or `positionSeconds`
  // when the caller knows it exactly (the place an OSC episode switch left,
  // from the action's time-pos: the poll may lag it by up to 250 ms).
  const flushProgress = useCallback(async (positionSeconds?: number) => {
    const durationValue = fallbackDuration || safeDuration;
    const time = Math.max(0, positionSeconds ?? lastKnownTimeRef.current);
    if (!durationValue || durationValue <= 0) {
      playbackDebugLog.warn({ fallbackDuration, safeDuration, lastKnownTime: time }, "flushProgress: no duration, skipping save");
      return;
    }
    const pct = (time / durationValue) * 100;
    playbackDebugLog.info({ time, durationValue, pct, mediaId: media.id, episodeId }, "flushProgress");
    if (Number.isFinite(pct) && pct >= 0) {
      // Phase 2: persist absolute position + duration so the credits-aware
      // completion check can compare in seconds, not derive from pct (which
      // drifts on re-transcode).
      await setProgress(media.id, pct, episodeId ?? null, {
        positionSeconds: time,
        durationSeconds: durationValue,
      });
    } else {
      playbackDebugLog.warn({ pct }, "flushProgress: pct not finite, skipping");
    }
  }, [episodeId, fallbackDuration, media.id, safeDuration, setProgress]);

  const setExternalMpvSessionActive = useCallback((active: boolean) => {
    window.dispatchEvent(new CustomEvent(EXTERNAL_MPV_SESSION_EVENT, { detail: { active } }));
  }, []);

  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer) return;
    const unsubscribe = window.sf?.onMpvExternalMessage?.(async (msg) => {
      if (msg.type !== "exit") return;
      // Lifecycle bookkeeping is owned by the main-process reducer — it
      // dispatches `process_exited` and transitions the lifecycle to "idle"
      // before this renderer-side IPC notification fires. The next loadStream
      // therefore observes `lifecycle.kind === "idle"` and takes the launch
      // branch (rather than loadfile-into-dead-process). All we still do here
      // is the renderer-local progress flush. (PR 3.2e: the reveal flip is
      // owned by the phase reducer — the lifecycle subscription already
      // dispatches process_gone at L266, which takes phase to idle and
      // derives isReadyToReveal=false.)
      // Phase-5 close-out: properly await flushProgress so the IPC
      // round-trip (renderer → main → runtime → SQLite write +
      // refreshAndEmitProxySnapshot push) has run to completion before
      // the listener returns. Without the await, the SQLite write was
      // durable but the snapshot push back to the renderer raced the
      // throttle window, leaving a brief stale-progressPct window for
      // users who navigate to the title immediately after stopping
      // playback. Errors are swallow-and-logged: progress save is
      // best-effort; we MUST still clear the session-active flag so a
      // subsequent loadStream takes the launch branch correctly.
      try {
        await flushProgress();
      } catch (err) {
        playbackDebugLog.warn(
          { message: err instanceof Error ? err.message : String(err) },
          "flushProgress on mpv exit failed",
        );
      } finally {
        setExternalMpvSessionActive(false);
      }
    });
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [flushProgress, open, setExternalMpvSessionActive]);

  const clearBufferingTimer = useCallback(() => {
    if (bufferingTimerRef.current !== null) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
  }, []);

  const holdManualState = useCallback((ms: number) => {
    manualStateUntilRef.current = Math.max(manualStateUntilRef.current, Date.now() + ms);
  }, []);

  const holdStartupState = useCallback((ms: number) => {
    startupHoldUntilRef.current = Math.max(startupHoldUntilRef.current, Date.now() + ms);
  }, []);

  const setBufferingImmediate = useCallback(
    (next: boolean) => {
      clearBufferingTimer();
      if (next) {
        bufferingHoldUntilRef.current = Date.now() + 400;
        setIsBuffering(true);
        return;
      }
      const remaining = bufferingHoldUntilRef.current - Date.now();
      if (remaining > 0) {
        bufferingTimerRef.current = window.setTimeout(() => {
          bufferingTimerRef.current = null;
          setIsBuffering(false);
        }, remaining);
        return;
      }
      setIsBuffering(false);
    },
    [clearBufferingTimer]
  );

  const setBufferingFromPoll = useCallback(
    (next: boolean) => {
      if (userPausedRef.current && next) {
        return;
      }
      if (next) {
        if (bufferingTimerRef.current !== null) return;
        bufferingTimerRef.current = window.setTimeout(() => {
          bufferingTimerRef.current = null;
          bufferingHoldUntilRef.current = Date.now() + 400;
          setIsBuffering(true);
        }, 150);
        return;
      }
      clearBufferingTimer();
      const remaining = bufferingHoldUntilRef.current - Date.now();
      if (remaining > 0) {
        bufferingTimerRef.current = window.setTimeout(() => {
          bufferingTimerRef.current = null;
          setIsBuffering(false);
        }, remaining);
        return;
      }
      setIsBuffering(false);
    },
    [clearBufferingTimer]
  );

  useEffect(() => () => clearBufferingTimer(), [clearBufferingTimer]);

  const releaseHlsSession = useCallback(async (session: HlsSession | null) => {
    if (!session) return;
    await window.sf?.releasePlaybackHlsSession?.(session.id).catch(() => null);
  }, []);

  const releaseOfflineSession = useCallback(async (sessionId: string | null) => {
    if (!sessionId) return;
    await window.sf?.releasePlaybackHlsSession?.(sessionId).catch(() => null);
  }, []);

  /**
   * Offline playback (OFFL-FILE-03): try to open an HLS session over the sealed pieces saved on this device for the
   * current `fileId`, built by MAIN from the item manifest (the same HLS path as streaming; MAIN serves the pieces
   * locally, decrypting them, with no token and no network). Null when this title is not saved as pieces here (or the
   * manifest is gone), so the caller falls back to streaming. @bugfix offline-playback-ignored-local-file
   */
  const tryCreateOfflineSession = useCallback(async (): Promise<{
    id: string;
    url: string;
    subtitleKeys: string[];
  } | null> => {
    if (!window.sf?.createPlaybackOfflineHlsSession || !fileId) return null;
    // The offline-state store (hydrated from the runtime's list_local) holds the trusted manifest path: no IPC
    // round-trip on the common streaming path.
    const manifestPath = offlineManifestPathForFile(fileId);
    if (!manifestPath) {
      mpvLog.info({ fileId }, "loadStream: no offline pieces in store — using stream");
      return null;
    }
    try {
      const session = await window.sf.createPlaybackOfflineHlsSession({ fileId, manifestPath });
      mpvLog.info(
        { fileId, mediaId: media.id, sessionId: session.id, subtitles: session.subtitleKeys.length },
        "loadStream: offline pieces found — playing from this device",
      );
      return session;
    } catch (err) {
      mpvLog.warn(
        { fileId, manifestPath, reason: err instanceof Error ? err.message : String(err) },
        "loadStream: offline session create failed — falling back to stream",
      );
      return null;
    }
  }, [fileId, media.id]);

  const createHlsSession = useCallback(async () => {
    if (!window.sf?.createPlaybackHlsSession) {
      throw new Error("playback_hls_unavailable");
    }
    const videoEntries = formats
      .map((format) => {
        const map = buildChunkMapFromFormat(format);
        if (!map) return null;
        return {
          id: format.id,
          quality: format.quality,
          bitrateKbps: format.bitrateKbps ?? null,
          width: null,
          height: null,
          track: buildHlsTrackFromChunkMap(map, format.codecString ?? null),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const audioEntries = audioOptions
      .map((track) => {
        if (!track.initKey || !track.chunks?.length) return null;
        const map = buildChunkMapFromFormat({
          initKey: track.initKey,
          initSize: track.initSize ?? null,
          durationSeconds: track.durationSeconds ?? null,
          totalSize: track.totalSize ?? null,
          chunks: track.chunks,
        });
        if (!map) return null;
        return {
          id: track.id,
          language: track.language,
          label: track.label || track.language,
          isDefault: Boolean(track.isDefault),
          track: buildHlsTrackFromChunkMap(map, track.codecString ?? null),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (audioOptions.length > 0 && audioEntries.length === 0) {
      throw new Error("playback_stream_audio_missing");
    }
    if (videoEntries.length === 0) {
      throw new Error("playback_hls_video_missing");
    }
    return await window.sf.createPlaybackHlsSession({
      mode: "vod",
      videos: videoEntries,
      audio: audioEntries,
    });
  }, [audioOptions, formats]);

  const loadStream = useCallback(
    async (options: { startTime: number | null; paused: boolean }) => {
      const debugTiming = import.meta.env.DEV && import.meta.env.VITE_DEBUG;
      const startMark = performance.now();
      // PR 3.2c-3: the launchInProgressRef concurrency latch (formerly set
      // synchronously here before any await) is gone. Concurrent entry is
      // now prevented by `isLoadInFlight(phaseRef.current)` at:
      //   - the init-effect top guard (engine ~L2259, PR 3.2c-1) AND
      //   - the start_load dispatch happening SYNCHRONOUSLY at the init-
      //     effect top + startFrom zero-seek BEFORE pauseForChange (PR
      //     3.2c-2). A second concurrent init-effect re-fire reads
      //     phase=launching → bails before any side effect.
      // @bugfix mpv-launch-loop-from-controller-mount-storm (phase-resolved)
      // @bugfix mpv-launch-init-effect-pre-loadstream-window (phase-resolved)
      // Until mpv reaches this start it reports its pre-seek position (0);
      // the poll / format switch / reload must not trust that (issue #25 P8).
      // @bugfix @regression-proof issue #25 c061: on a live mpv this load is
      // a `loadfile replace`; until the new file loads, every polled sample
      // is the OLD file's position and must not "reach" the new target.
      const armedStart = isExternalActive(lifecycleRef.current)
        ? pendingStart.armForReload(options.startTime)
        : pendingStart.arm(options.startTime);
      mpvLog.info({
        phaseKind: phaseRef.current.kind,
        lifecycleKind: lifecycleRef.current.kind,
        startTime: options.startTime,
        paused: options.paused,
        pendingStart: armedStart,
        loadInFlight: pendingStart.isLoadInFlight(),
      }, "loadStream: enter");
      // Direct launch and reload arm this before their load (the backdrop
      // handoff classifies its own end-files); the finally below disarms it.
      // @bugfix @regression-proof issue #25 P8 residual.
      let fallbackWatch: HlsMasterFallbackWatch | null = null;
      let stopWatchingReloadFileLoaded: (() => void) | undefined;
      const failOnHlsMasterFallback = async (
        verdict: ExternalLoadVerdict,
        branch: "direct" | "reload",
        sessionUrl: string,
      ): Promise<never> => {
        mpvLog.error({
          branch,
          verdict,
          sessionUrl,
          startTime: options.startTime,
          lifecycleKind: lifecycleRef.current.kind,
        }, "loadStream: HLS master fell back to a single variant playlist (a rendition's init/playlist failed to load) — failing the load instead of playing video-only from 0:00");
        await window.sf?.stopExternalMpv?.().catch((err: unknown) => {
          mpvLog.warn(
            { message: err instanceof Error ? err.message : String(err) },
            "loadStream: stopExternalMpv after HLS master fallback failed",
          );
        });
        throw new Error(HLS_MASTER_FALLBACK_ERROR);
      };
      try {
      // Offline-first source selection: prefer the pieces saved on this device so
      // playback works with the server unreachable. Falls back to the
      // HLS/tunnel path when this file is not saved here as pieces.
      // @bugfix offline-playback-ignored-local-file
      const offlineSource = await tryCreateOfflineSession();
      const isOfflineSource = offlineSource !== null;
      offlineSubtitleKeysRef.current = offlineSource ? new Set(offlineSource.subtitleKeys) : null;
      // Per-load tracks of a (re)load: an OSC pick of this file first (P18), else the app's audio choice as its HLS
      // `aid` (PLAY-TRACK-04). An offline source keeps mpv's default track (the saved audio set may differ from the
      // streamed one, so the app's index does not apply).
      const loadTrackOptions = () => {
        const picks = oscTrackPicksRef.current.reloadOptions(fileIdRef.current);
        return { ...picks, audioTrack: picks.audioTrack ?? (isOfflineSource ? null : appAudioTrackRef.current) };
      };
      // ACCT-STREAM-01..03: a streamed source asks the server for this profile's place first (the question at the
      // limit included; a place already held is reused); a downloaded copy never counts and gives a held place back.
      // Cancel closes the player quietly (lib/streamSlot.ts).
      if (isOfflineSource) void releaseDesktopStreamSlot();
      else if ((await acquireDesktopStreamSlot()) === "cancel") throw new Error(PLAYBACK_LOAD_STOPPED);
      let session: HlsSession;
      if (offlineSource) {
        session = offlineSource;
        // Release prior sessions of BOTH kinds so switching between a streamed
        // and a downloaded title never leaks a session.
        await releaseHlsSession(hlsSessionRef.current);
        hlsSessionRef.current = null;
        await releaseOfflineSession(offlineSessionRef.current);
        offlineSessionRef.current = offlineSource.id;
      } else {
        if (!effectiveFormatMapRef.current) {
          throw new Error("playback_stream_format_missing");
        }
        session = await createHlsSession();
        if (debugTiming) {
          mpvLog.debug({ elapsedMs: Math.round(performance.now() - startMark) }, "load timing hls");
        }
        await releaseHlsSession(hlsSessionRef.current);
        hlsSessionRef.current = session;
        await releaseOfflineSession(offlineSessionRef.current);
        offlineSessionRef.current = null;
      }

      if (mpvFlagsRef.current.externalPlayer) {
        // Always check if the mpv process is actually alive. The exit IPC
        // event can arrive after the user clicks play, leaving the renderer's
        // lifecycle snapshot stale for a frame. Ask the main process
        // directly — this is synchronous and reliable unlike probing the IPC
        // socket (which may hang on a stale socket file). If we observe a
        // dead process despite a non-idle lifecycle snapshot, the main side
        // will dispatch process_exited shortly and the snapshot will
        // catch up; we fall through to the launch branch in the meantime.
        const lifecycleKindAtBranch = lifecycleRef.current.kind;
        let processActive = isExternalActive(lifecycleRef.current);
        const aliveProbeStartedAt = Date.now();
        if (processActive) {
          const alive = await window.sf?.isExternalMpvAlive?.().catch(() => false);
          if (alive !== true) {
            processActive = false;
          }
        }
        mpvLog.info({
          lifecycleKindAtBranch,
          processActive,
          path: processActive ? "loadfile" : "launch",
          aliveProbeMs: Date.now() - aliveProbeStartedAt,
        }, "loadStream: branch chosen");
        if (!processActive) {
          // No live mpv: no old file whose samples need ignoring.
          pendingStart.loadLanded();
          // A fresh mpv launch: no load, no first frame, no reload to wait out.
          // @bugfix issue #25 P8
          noteLaunch(abrCtrl);
          setExternalMpvSessionActive(true);
          // Capture the launch log file path (used to be tracked via a
          // dedicated renderer ref). This stays scoped to the call so the
          // optional ready-warning below can include it for diagnostics.
          let launchLogFile: string | null = null;
          try {
            const metricsStart = Date.now();
            await window.sf?.resetPlaybackSignedUrlMetrics?.();
            const shouldPlay = !options.paused;
            const shouldLaunchPaused =
              options.paused || (options.startTime !== null && options.startTime > ZERO_SEEK_EPS);
            // Pre-warm chunks at the resume offset BEFORE launching mpv.
            // The HLS proxy is empty on freshly-created sessions; mpv
            // launches and immediately requests init+segment-at-offset,
            // both of which trigger cold storage tunnel fetches inside the
            // proxy. With `--keep-open=yes` and `--hls-bitrate=...`, mpv's
            // HLS demuxer treats slow first reads as stream errors and
            // retries by seeking back to the playlist start — the
            // user-observed 3–10 s segment loop on Resume from a non-zero
            // position.
            //
            // Warming init + the segment containing `startTime` collapses
            // mpv's first-read latency from hundreds of ms (cold storage) to
            // microseconds (in-memory cache hit). The existing per-key
            // prefetch chain (playbackServer.ts:1039) then handles the
            // next 1–N segments organically.
            //
            // Awaited so the loading UI stays visible until chunks are
            // staged. User preferred a longer "loading playback" UI over
            // the looping behavior.
            //
            // @bugfix mpv-launch-loop-cold-hls-proxy
            // The metadata payload (on-disk sidecar lookup, no download wait),
            // this prewarm (PREWARM_BUDGET_MS) and the backdrop still
            // (PLAYBACK_BACKDROP_TIMEOUT_MS) are independent: they start
            // together and mpv waits for the slowest, not their sum (up to
            // 6.5 s serial on a 2-core Celeron, #928). @see runPrelaunchLoads
            const prewarmStartMs = Date.now();
            // Cap prewarm wait so a slow storage tunnel can't block launch
            // indefinitely. mpv fetches whatever prewarm did not stage
            // itself and starts once the stream at the resume offset is
            // playable (#25 playable-start: no prefill) — so if prewarm
            // doesn't finish in time, mpv will
            // still arrive at the right position safely (it just won't
            // have a microsecond first-read; mpv pays the cold-fetch
            // cost itself). The window-hide path stays bounded.
            //
            // Pre-fix the prewarm was uncapped — `getObjectPayload` →
            // `fetchObjectViaTunnel` has no timeout, so a slow chunk
            // fetch could stall the entire launch flow before mpv even
            // spawned. User-observed delay between "click Resume" and
            // "Electron window hides behind mpv" was up to ~60 s on
            // cold-storage paths. With this cap, that wait collapses to ~2 s
            // worst-case; the rest happens during mpv's own first fetch,
            // which the app-window already overlays.
            //
            // @bugfix mpv-window-hide-delay-uncapped-prewarm
            const PREWARM_BUDGET_MS = 2000;
            // Set when prewarm DEFINITIVELY failed: it returned (did not time
            // out) having warmed ZERO chunks while missing at least one — the
            // storage tunnel/API delivered nothing, i.e. the source is
            // unreachable. A prewarm TIMEOUT (null) is deliberately NOT this:
            // the server may be up but slow, which is a valid cold launch.
            // @bugfix offline-playback-silent-bounce-when-unreachable
            const runPrewarm = async (): Promise<{ sourceUnreachable: boolean }> => {
              let sourceUnreachable = false;
              try {
                // Offline sessions prewarm too: the pieces are read and decrypted locally (no tunnel), so mpv's
                // first reads are warm. @bugfix offline-playback-ignored-local-file
                if (window.sf?.prewarmPlaybackHlsSession) {
                  const prewarmPromise = window.sf.prewarmPlaybackHlsSession({
                    sessionId: session.id,
                    videoId: effectiveFormat?.id ?? null,
                    audioId: selectedAudioId ?? null,
                    startSeconds: options.startTime ?? null,
                  });
                  const timeoutPromise = new Promise<null>((resolve) =>
                    window.setTimeout(() => resolve(null), PREWARM_BUDGET_MS),
                  );
                  const prewarmResult = await Promise.race([prewarmPromise, timeoutPromise]);
                  if (prewarmResult === null) {
                    mpvLog.warn({
                      sessionId: session.id,
                      startSeconds: options.startTime ?? null,
                      budgetMs: PREWARM_BUDGET_MS,
                      elapsedMs: Date.now() - prewarmStartMs,
                    }, "loadStream: hls prewarm exceeded budget — proceeding (mpv fetches the cold chunks itself)");
                  } else {
                    mpvLog.info({
                      sessionId: session.id,
                      startSeconds: options.startTime ?? null,
                      warmed: prewarmResult.warmedKeys.length,
                      missed: prewarmResult.missedKeys.length,
                      elapsedMs: prewarmResult.elapsedMs,
                    }, "loadStream: hls prewarm complete");
                    // Zero warmed + at least one missed = the tunnel delivered
                    // nothing → source unreachable. Never for an offline source:
                    // its pieces are on this device.
                    sourceUnreachable =
                      !isOfflineSource &&
                      prewarmResult.warmedKeys.length === 0 &&
                      prewarmResult.missedKeys.length > 0;
                  }
                }
              } catch (error) {
                mpvLog.warn({
                  sessionId: session.id,
                  elapsedMs: Date.now() - prewarmStartMs,
                  error: error instanceof Error ? error.message : String(error),
                }, "loadStream: hls prewarm failed (proceeding with cold launch)");
              }
              return { sourceUnreachable };
            };
            // The bundled mpv's first exec (Defender's scan) runs in a main-side worker during these loads;
            // the launch below awaits it. Usually already started when the details dialog opened (#928).
            void window.sf?.warmExternalMpv?.().catch(() => undefined);
            const prelaunch = await runPrelaunchLoads({
              // Offline and streamed sources share the HLS path: subtitles are external sidecars via the proxy (an
              // offline source offers only the ones saved with it). @bugfix offline-playback-ignored-local-file
              metadata: buildExternalMetadataPayload,
              prewarm: runPrewarm,
              // A data URI of the user's own copy (META-ART-01), never a source nor its image CDN.
              // Null when there is no copy yet, after a short wait or on failure: mpv then launches straight on the stream.
              backdrop: () =>
                resolvePlaybackBackdrop(media.backdropPath, {
                  isAssetKey,
                  getAssetUrl: async (assetRef) => {
                    const libraryKey = await getStoredLibraryKey();
                    return token && libraryKey ? getDecryptedAssetUrl(token, libraryKey, assetRef) : null;
                  },
                  toDataUrl: objectUrlToDataUrl,
                }),
            });
            // Timings first, as one string: the renderer console preview keeps ~5 fields.
            mpvLog.info({
              timeline: formatLaunchTimeline({
                ...prelaunch.timings,
                sinceLoadStreamMs: Math.round(performance.now() - startMark),
              }),
              // Data URI header only (never the image): main caches jpeg/png/webp, anything else opens mpv black.
              backdropType: prelaunch.backdrop?.split(",", 1)[0] ?? null,
            }, "loadStream: pre-launch loads settled");
            const metadataPayload = prelaunch.metadata;
            const { sourceUnreachable } = prelaunch.prewarm;
            const backdropUrl = prelaunch.backdrop;
            // If the streamed source is demonstrably unreachable (no offline
            // copy AND the tunnel delivered zero chunks), abort BEFORE
            // launching mpv. Pre-fix mpv launched on the backdrop, the Electron
            // window hid, the stream loadfile then failed on dead chunks and
            // mpv exited — the user saw the app "bounce" with no explanation.
            // We surface a clear "not saved offline / server unreachable"
            // error instead. @bugfix offline-playback-silent-bounce-when-unreachable
            if (sourceUnreachable) {
              mpvLog.warn(
                { sessionId: session.id },
                "loadStream: source unreachable (prewarm warmed 0 chunks, no offline copy) — aborting before mpv launch",
              );
              throw new Error("playback_source_unreachable");
            }
            // Backdrop-first launch path. Resolve the catalog backdrop URL from
            // the media; if available, launch mpv with the static image as
            // the source, then signalPlaybackReady IMMEDIATELY so the
            // Electron window hides within ~1 s of the user click. The
            // existing metadata+ready-gate chain then runs in the
            // BACKGROUND and finishes by sending a `loadfile <streamUrl>
            // replace -1 start=<resumeTime>` IPC to swap from image to
            // stream. `--keep-open=yes` keeps the last image frame visible
            // during the brief swap, and the stream starts as soon as it is
            // playable (#25 playable-start: no prefill; a first-GOP resume
            // prefills only its short window).
            //
            // If the media has no backdrop, fall back to the prior
            // launch-directly-on-stream behavior — the user still gets a
            // bounded window-hide path (prewarm cap + subtitle cache cap
            // ensure pre-launch awaits never exceed ~5 s).
            //
            // The seek gate (seeksAllowed(phase) — false in backdropHandoff)
            // ensures ensureExternalSeek can't fire seeks against an
            // image-only mpv during the handoff window.
            //
            // @bugfix mpv-window-hide-via-backdrop-handoff
            // `backdropUrl` was resolved with the other pre-launch loads above.
            const useBackdropHandoff = Boolean(backdropUrl);
            // mpv must launch UNPAUSED in backdrop mode (the image otherwise
            // never displays — mpv won't start any output while paused with
            // no frames decoded). For direct-stream launches we preserve the
            // existing shouldLaunchPaused semantics so a `--start=<time>`
            // launch still shows its first frame before the unpause.
            const launchPaused = useBackdropHandoff ? false : shouldLaunchPaused;
            // Offline = a single muxed file, no HLS ABR → no bitrate hint.
            const bitrateKbps = isOfflineSource ? null : (effectiveFormat?.bitrateKbps ?? null);
            if (!useBackdropHandoff) {
              // Armed before the launch so an instant fallback cannot slip by.
              fallbackWatch = watchHlsMasterFallback(window.sf?.onMpvExternalMessage, (info) => {
                mpvLog.info({ ...info, branch: "direct" }, "loadStream: direct launch saw mpv end-file");
              });
            }
            const launchIpcStartMs = Date.now();
            const launchInfo = await window.sf?.launchExternalMpv?.({
              url: session.url,
              backdropUrl: backdropUrl,
              startTime: useBackdropHandoff
                ? null
                : (options.startTime !== null && options.startTime > 0 ? options.startTime : null),
              paused: launchPaused,
              hlsBitrateBps: bitrateKbps ? Math.max(1, Math.round(bitrateKbps * 1000)) : null,
              // A launch on the stream opens on these tracks; a backdrop launch's handoff loadfile carries them.
              // @bugfix @regression-proof #2762
              ...loadTrackOptions(),
            });
            mpvLog.info({
              timeline: formatLaunchTimeline({
                launchIpcMs: Date.now() - launchIpcStartMs,
                mainPrepareMs: launchInfo?.timings?.prepareMs ?? null,
                mainWarmupWaitMs: launchInfo?.timings?.warmupWaitMs ?? null,
                mainStartMs: launchInfo?.timings?.startMs ?? null,
                sinceLoadStreamMs: Math.round(performance.now() - startMark),
              }),
              useBackdropHandoff,
              hasBackdrop: backdropUrl !== null,
              // The main process only shows a still it could cache (jpeg/png/webp data URI); otherwise mpv opens black.
              backdropStill: launchInfo?.args?.includes("--image-display-duration=inf") ?? false,
            }, "loadStream: launchExternalMpv IPC complete");
            if (launchInfo?.args && Array.isArray(launchInfo.args)) {
              const logArg = launchInfo.args.find((arg: string) => arg.startsWith("--log-file="));
              launchLogFile = logArg ? logArg.replace("--log-file=", "") : null;
            }
            if (debugTiming) {
              mpvLog.debug({ elapsedMs: Math.round(performance.now() - startMark) }, "load timing launch");
            }
            setBufferingImmediate(true);
            setIsPlaying(false);
            // PR 3.2e: phase=launching already implies isReadyToReveal=false
            // (deriveIsReadyToReveal returns false for launching). No flip
            // needed — start_load at the top of loadStream put us there.
            // Backdrop branch: fire signalPlaybackReady RIGHT NOW so the
            // Electron window hides immediately. mpv is up displaying the
            // backdrop image; the user sees mpv with a still placeholder
            // while we work in the background to load the actual stream.
            if (useBackdropHandoff && isExternalActive(lifecycleRef.current)) {
              const sigBackdropStartMs = Date.now();
              try {
                await window.sf?.signalPlaybackReady?.();
                mpvLog.info({
                  sigMs: Date.now() - sigBackdropStartMs,
                  handoffPhase: "backdrop",
                }, "loadStream: signalPlaybackReady IPC complete (backdrop) — window hide");
              } catch (err) {
                mpvLog.warn(
                  { message: err instanceof Error ? err.message : String(err) },
                  "signalPlaybackReady failed (backdrop phase)",
                );
              }
              // Flip the user-visible "loading dismissed" signal so the
              // controller's loading-modal effect tears down in lockstep
              // with the window hide. PR 3.2e: backdrop_shown advances
              // phase to backdropHandoff, which derives isReadyToReveal=true.
              // The "stream is playing" moment comes later when the
              // stream_loadfile_done event advances to playing.
              // backdrop_shown is the deliberate locked split moment:
              // After this, deriveIsReadyToReveal(phase)=true but
              // seeksAllowed(phase)=false until stream_loadfile_done
              // at L1708 below.
              dispatchPhase({ type: "backdrop_shown" });
            }
            if (debugTiming) {
              const launchMetrics = await window.sf?.getPlaybackSignedUrlMetrics?.();
              if (launchMetrics?.resetAt) {
                const elapsedMs = Date.now() - metricsStart;
                mpvLog.debug({
                  elapsedMs,
                  signedUrlRequests: launchMetrics.requests,
                }, "external launch metrics");
              }
              const metrics = await window.sf?.getPlaybackSignedUrlMetrics?.();
              if (metrics?.resetAt) {
                const elapsedMs = Date.now() - metricsStart;
                mpvLog.debug({
                  elapsedMs,
                  signedUrlRequests: metrics.requests,
                }, "external open metrics");
              }
              window.setTimeout(() => {
                void getProperty(sendExternalRequest, "time-pos").then((value) => {
                  mpvLog.debug({ value }, "external time-pos");
                });
              }, 600);
            }
            // BACKDROP PATH: skip the stream-aware phase-1 (tracks-stable
            // is meaningless against an image with one video track and no
            // audio, and metadata is sent post-loadfile-swap so sf.lua sees
            // the actual stream's track list). Send the loadfile swap now
            // and let mpv start the stream as soon as it is playable (the
            // per-load cache policy, @space/mpv-protocol buildLoadfileCommand).
            if (useBackdropHandoff) {
              const swapStartMs = Date.now();
              // LOAD-FAILURE DETECTION (issue #25, @bugfix
              // mpv-handoff-load-failure-black-idle-window). mpv was launched
              // IDLE, so a failed swap (404, dead tunnel, bad codec, rejected
              // loadfile) does NOT make mpv exit: it drops back to idle as a
              // black window while the app window is already hidden. Pre-fix
              // this branch fell through to the ~20 s tracks/vo waits and then
              // reported playback as running. Every signal below goes through
              // `classifyExternalLoadSignal`; any failure verdict aborts:
              // close mpv (main shows the app window) and throw, so the init
              // catch surfaces the playback error.
              // The end-file and file-loaded listeners are armed BEFORE the
              // swap so an instant failure, or a file-loaded that beats a
              // slow `loadfile` reply, cannot slip past them.
              let stopWatchingLoadEvents: (() => void) | undefined;
              let resolveFileLoaded: () => void = () => {};
              const fileLoaded = new Promise<void>((resolve) => {
                resolveFileLoaded = resolve;
              });
              const endFileFailure = new Promise<ExternalLoadVerdict>((resolve) => {
                const unsubscribe = window.sf?.onMpvExternalMessage?.((msg) => {
                  if (msg.type === "file_loaded") {
                    mpvLog.info({ sinceSwapMs: Date.now() - swapStartMs }, "loadStream: backdrop handoff saw mpv file-loaded");
                    resolveFileLoaded();
                    return;
                  }
                  if (msg.type !== "end_file") return;
                  const verdict = classifyExternalLoadSignal({
                    kind: "end_file",
                    reason: msg.reason,
                    fileError: msg.fileError,
                  });
                  mpvLog.info({
                    sinceSwapMs: Date.now() - swapStartMs,
                    reason: msg.reason,
                    fileError: msg.fileError,
                    verdict,
                  }, "loadStream: backdrop handoff saw mpv end-file");
                  if (verdict.failed) resolve(verdict);
                });
                stopWatchingLoadEvents = typeof unsubscribe === "function" ? unsubscribe : undefined;
              });
              const abortHandoff = async (verdict: ExternalLoadVerdict): Promise<never> => {
                // error level: a failed load (incl. the issue #25 P8 HLS master
                // fallback, verdict.cause=hls_master_fallback) is never routine.
                // Cause and detail first, as strings: the renderer console
                // preview prints nested objects as "Object" (S1 c038).
                mpvLog.error({
                  stopCause: "handoff-load-failed",
                  verdictCause: verdict.failed ? verdict.cause : null,
                  verdictDetail: verdict.failed ? verdict.detail : verdict.why,
                  sinceSwapMs: Date.now() - swapStartMs,
                  lifecycleKind: lifecycleRef.current.kind,
                }, "loadStream: backdrop->stream load FAILED — closing idle mpv, showing the app window");
                await window.sf?.stopExternalMpv?.().catch((err: unknown) => {
                  mpvLog.warn(
                    { message: err instanceof Error ? err.message : String(err) },
                    "loadStream: stopExternalMpv after handoff load failure failed",
                  );
                });
                throw new Error("playback_handoff_load_failed");
              };
              try {
                // Per-load options carry start + pause so the cmdline --start
                // / --pause don't apply (they were intentionally omitted from
                // the launch in backdrop mode). mpv replaces the source and
                // immediately seeks to `start=` before decoding the first
                // stream frame.
                // A reply that timed out (busy PC) is UNKNOWN, not a failure
                // (issue #25 P17): awaitHandoffLoadfile then waits for
                // file-loaded / end-file. A reply that never came from mpv
                // (IPC connect/write failure) re-sends the loadfile (issue #25
                // S1 c038). Only an mpv error reply or an end-file error aborts.
                const sendHandoffLoadfile = () =>
                  sendExternalCommandReply(
                    buildLoadfileCommand(session.url, "replace", {
                      startSeconds: options.startTime ?? null,
                      paused:
                        !shouldPlay ||
                        !autoPlayAllowed({
                          playRequestedAt: playRequestedAtRef.current,
                          userPausedAt: userPausedAtRef.current,
                        }),
                      ...loadTrackOptions(),
                    }),
                  );
                const swap = await awaitHandoffLoadfile({
                  reply: sendHandoffLoadfile(),
                  resend: sendHandoffLoadfile,
                  fileLoaded,
                  endFileFailure,
                });
                mpvLog.info({
                  swapMs: Date.now() - swapStartMs,
                  settledBy: swap.settledBy,
                  failed: swap.verdict.failed,
                  verdictDetail: swap.verdict.failed ? swap.verdict.detail : swap.verdict.why,
                  transportRetries: swap.transportRetries ?? 0,
                  startTime: options.startTime,
                  paused: !shouldPlay,
                }, "loadStream: backdrop->stream loadfile swap dispatched");
                if (swap.verdict.failed) await abortHandoff(swap.verdict);
                // ORDER MATTERS: wait for the NEW stream's track-list to
                // stabilize BEFORE sending sf.lua's metadata (sub-add /
                // audio-track-add / chapter-add). Pre-fix the metadata was
                // sent at swap-time 0-300 ms after loadfile, while mpv was
                // still demuxing the new source. mpv's `sub-add` is
                // synchronous to the CURRENT track-list snapshot — sub-add
                // calls fired against an in-flight loadfile either landed
                // on the empty image session (and got blown away when the
                // stream's own tracks materialized) or were applied to a
                // partial demuxer state that mpv subsequently reset.
                //
                // Confirmed via /tmp/sf-mpv-external-1779202313094.log: 20
                // `Run command: sub-add` lines at mpv-time 0.039-0.041 s,
                // BEFORE the stream's tracks-stable (0.535 s "first video
                // frame after restart"). The track list mpv settled on had
                // NO external sub entries — sub-add was racing the
                // loadfile reset.
                //
                // With waitForExternalTracksStable in front, sf.lua's
                // sub-add fires on a fully-formed stream session and the
                // externals stick.
                //
                // @bugfix mpv-backdrop-handoff-metadata-before-stream-stable
                //
                // The waits race the end-file failure so a failed load aborts
                // as soon as mpv reports it instead of after the wait budgets.
                const earlyFailure = await Promise.race([
                  (async () => {
                    await waitForExternalTracksStable();
                    await waitForVoConfigured(5000);
                    return null;
                  })(),
                  endFileFailure,
                ]);
                if (earlyFailure) await abortHandoff(earlyFailure);
                // Last line of defence: a load that failed without an
                // end-file we saw (event socket reconnecting) leaves mpv idle.
                const idleActive = await getProperty(sendExternalRequest, "idle-active");
                const idleVerdict = classifyExternalLoadSignal({ kind: "idle_active", value: idleActive });
                mpvLog.info({
                  sinceSwapMs: Date.now() - swapStartMs,
                  idleActive,
                  verdict: idleVerdict,
                }, "loadStream: backdrop handoff post-wait idle-active check");
                if (idleVerdict.failed) await abortHandoff(idleVerdict);
              } finally {
                stopWatchingLoadEvents?.();
              }
              // Adaptive backoff (0/100/300 ms) — shared with the
              // direct-launch and reload branches via the pure helper. The
              // `await waitForExternalTracksStable()` above must STAY here
              // (NOT move into the helper): the backdrop branch is the only
              // path that requires the stream's track-list to settle BEFORE
              // metadata sends — see @bugfix
              // mpv-backdrop-handoff-metadata-before-stream-stable. The
              // direct/reload branches deliberately overlap their tracks
              // wait with the metadata send (Promise.all), so the helper
              // stays sequencing-agnostic.
              await sendMetadataWithBackoff(() => sendExternalMetadataUnchecked(metadataPayload));
              // PR 3.2d: backdrop path's stream loadfile done. Closes the
              // deliberate locked split — seeks are now allowed
              // (backdropHandoff → playing).
              dispatchPhase({ type: "stream_loadfile_done" });
              mpvLog.info({
                totalSwapMs: Date.now() - swapStartMs,
                lifecycleKind: lifecycleRef.current.kind,
              }, "loadStream: backdrop->stream handoff complete; seek gate open");
              if (shouldPlay) {
                setBufferingImmediate(false);
                setIsPlaying(true);
                holdStartupState(1500);
              }
              // The stream is mpv's now: the ABR clock waits for its first
              // frame (mpv's playback-restart, not this handoff).
              // @bugfix issue #25 P8, N4
              noteLoadStarted(abrCtrl, Date.now());
              return;
            }
            // DIRECT (no-backdrop) PATH — original flow preserved.
            // Phase 1: in parallel, wait for tracks-stable AND start sending
            // metadata. mpv IPC accepts script-message commands the moment the
            // socket is up — the OSC script buffers them — so there's no point
            // serializing the send behind tracks-stable.
            const phase1StartMs = Date.now();
            mpvLog.info({ sinceLaunchMs: phase1StartMs - prewarmStartMs }, "loadStream: phase-1 start (tracks-stable + metadata)");
            const tracksStablePromise = waitForExternalTracksStable();
            // Adaptive backoff (0/100/300 ms) — shared with backdrop and
            // reload branches via the pure helper. Replaces the previous
            // fixed 200 ms × 3 = 600 ms of dead time. The metadata send
            // deliberately overlaps with tracksStablePromise via
            // Promise.all below — DO NOT inline `waitForExternalTracksStable`
            // ahead of this helper call (that's the backdrop branch's
            // serialized ordering, distinct from this path).
            const metadataPromise = sendMetadataWithBackoff(() => sendExternalMetadataUnchecked(metadataPayload));
            // Raced with the HLS master fallback watch (issue #25 P8): a
            // fallback still yields "stable tracks" (the lone variant's), so
            // waiting alone would report it as a healthy load.
            const phase1 = await Promise.race([
              Promise.all([tracksStablePromise, metadataPromise]).then(([stable]) => ({ ready: stable })),
              ...(fallbackWatch ? [fallbackWatch.failure] : []),
            ]);
            if ("failed" in phase1) return await failOnHlsMasterFallback(phase1, "direct", session.url);
            const { ready } = phase1;
            mpvLog.info({ phase1Ms: Date.now() - phase1StartMs, ready }, "loadStream: phase-1 complete");
            if (!ready) {
              const recoveredReady = await confirmExternalPlaybackReady();
              if (!shouldTreatRecoveredExternalStateAsReady(ready, recoveredReady)) {
                mpvLog.warn({ logFile: launchLogFile }, "external not ready after launch");
              }
            }
            if (options.startTime !== null) {
              if (options.startTime > ZERO_SEEK_EPS) {
                // mpv launched with `--start=<startTime>` on the cmdline, so
                // it WILL seek to that position as part of normal startup.
                // We only need to fall back to a manual exact-seek if mpv
                // reports a time-pos that is concretely far from target —
                // null/NaN means "still demuxing", which is the normal pre-VO
                // state and would only thrash if we re-seek (each retry adds
                // ~200 ms and forces mpv to re-decode from a new keyframe).
                // The verify-pass time-pos check is intentionally LENIENT here:
                // we trust the cmdline `--start` and only nudge when we have
                // a concrete number far from target.
                //
                // ADDITIONAL GUARD: only fire the verify-pass seek when mpv
                // reports a CONCRETE non-zero time-pos. Pre-fix, an in-flight
                // launch with `--start=<resumeTime>` where mpv hadn't finished
                // demuxing yet would report time-pos = 0 (a valid number, not
                // null) — the existing `current !== null && abs(0 - 3034) > 2`
                // check passed and the verify-pass called `ensureExternalSeek`.
                // That helper's 6-attempt internal loop then hammered mpv with
                // `seek absolute exact` commands every ~200 ms, each one
                // forcing mpv to abort demux, re-seek, restart decode. The
                // user heard this as the 3-10 s segment loop on Resume.
                // Confirmed via /tmp/sf-mpv-external-*.log: 4 seek commands
                // at mpv-time 3.2 / 5.3 / 8.5 / 11.1 s, all targeting the
                // SAME resume position.
                //
                // mpv's native --start / `start=` handling already lands on
                // the resume offset before the first frame, so the
                // verify-pass is a paranoia check — and that paranoia must
                // NOT punch through mpv's start seek by issuing a seek that
                // resets the demuxer. The combined gate (current > 0.5 AND
                // current diverges from target by > 2 s) means we only nudge
                // mpv after it's already reached SOME playable position and
                // that position is the wrong one. The "current = 0 mid-demux"
                // case now falls through and mpv finishes its native
                // --start handling without external interference.
                //
                // @bugfix mpv-launch-loop-verify-seek-hammer
                lastKnownTimeRef.current = options.startTime;
                const seekVerify = await getProperty(sendExternalRequest, "time-pos");
                const current = typeof seekVerify === "number" ? seekVerify : null;
                const target = options.startTime;
                const hasReachedPlayablePosition = current !== null && current > ZERO_SEEK_EPS;
                const divergesFromTarget = current !== null && Math.abs(current - target) > 2;
                mpvLog.info({
                  current,
                  target,
                  startTime: options.startTime,
                  hasReachedPlayablePosition,
                  divergesFromTarget,
                  willSeek: hasReachedPlayablePosition && divergesFromTarget,
                }, "loadStream: launch verify-pass decision");
                if (hasReachedPlayablePosition && divergesFromTarget) {
                  await ensureExternalSeek(options.startTime);
                }
              }
            }
            if (shouldPlay) {
              const resumeStartMs = Date.now();
              await resumeExternalPlayback({ auto: true });
              mpvLog.info({ resumeMs: Date.now() - resumeStartMs }, "loadStream: resumeExternalPlayback complete");
            }
            if (!isExternalActive(lifecycleRef.current)) {
              // mpv was stopped (user stop, dialog close) between the launch
              // and the ready gate: every gate below would bail on the dead
              // player after ~1 ms and warn as if the stream were broken
              // (shard-3 at 54c699a1d, playback.e2e resume-accuracy). Same
              // exit as the loadfile reload below.
              mpvLog.info({ lifecycleKind: lifecycleRef.current.kind }, "loadStream: mpv stopped during the launch — abandoning it");
              throw new Error(PLAYBACK_LOAD_STOPPED);
            }
            // Phase 2: ready-gate — wait for mpv's video output to be
            // configured (first frame ready). This is the load-bearing
            // "mpv has something on screen" signal; metadata-applied is
            // best-effort and runs in the background so a movie with many
            // external subtitles doesn't stretch the wait to 5-10 s.
            const READY_GATE_BUDGET_MS = 5000;
            const gateStart = Date.now();
            void waitForMetadataApplied(
              {
                expectedExternalSubtitles: metadataPayload.subtitles.length,
                expectedChapters: metadataPayload.chapters.length,
              },
              READY_GATE_BUDGET_MS,
            ).then((applied) => {
              if (!applied) {
                mpvLog.warn(
                  { elapsedMs: Date.now() - gateStart },
                  "metadata not fully applied within budget (best-effort; mpv already revealed)",
                );
              }
            });
            const voReady = await waitForVoConfigured(READY_GATE_BUDGET_MS);
            mpvLog.info({ voReady, voWaitMs: Date.now() - gateStart, lifecycleKind: lifecycleRef.current.kind }, "loadStream: waitForVoConfigured complete");
            if (!voReady) {
              mpvLog.warn(
                { elapsedMs: Date.now() - gateStart },
                "vo-configured did not fire before budget; revealing mpv anyway",
              );
            }
            // If mpv exited during the gate (user closed it, crash, network
            // tear-down), DO NOT hide Electron — the user is looking at the
            // app right now and hiding would surprise them. The exit IPC
            // handler in main already calls showWindow() to bring Electron
            // back if it was already hidden; we just have to not race it.
            const lateDirectFallback = fallbackWatch?.current();
            if (lateDirectFallback) await failOnHlsMasterFallback(lateDirectFallback, "direct", session.url);
            if (isExternalActive(lifecycleRef.current)) {
              const sigStartMs = Date.now();
              try {
                await window.sf?.signalPlaybackReady?.();
                mpvLog.info({ sigMs: Date.now() - sigStartMs }, "loadStream: signalPlaybackReady IPC complete");
              } catch (err) {
                mpvLog.warn(
                  { message: err instanceof Error ? err.message : String(err) },
                  "signalPlaybackReady failed",
                );
              }
            } else {
              mpvLog.info({ lifecycleKind: lifecycleRef.current.kind }, "skipping signalPlaybackReady — mpv exited during gate");
            }
            if (shouldPlay) {
              setBufferingImmediate(false);
              setIsPlaying(true);
              holdStartupState(1500);
            }
            // Direct-launch (no-backdrop) path: mpv is already on the
            // stream, so the seek gate opens at the same moment as the
            // visible reveal. The backdrop path opens it later (after
            // the loadfile swap completes — see L1745 dispatch above).
            // PR 3.2d + 3.2e: stream_loadfile_done dispatch is the sole
            // writer of both the seek-gate signal AND the public reveal
            // value (deriveIsReadyToReveal(playing) === true).
            dispatchPhase({ type: "stream_loadfile_done" });
            // The stream is mpv's now: the ABR clock waits for its first
            // frame (mpv's playback-restart, not this handoff).
            // @bugfix issue #25 P8, N4
            noteLoadStarted(abrCtrl, Date.now());
            return;
          } catch (error) {
            setExternalMpvSessionActive(false);
            // PR 3.2e: phase=idle (via load_failed below) drives
            // deriveIsReadyToReveal=false. No setIsReadyToReveal needed.
            dispatchPhase({ type: "load_failed" });
            throw error;
          }
        }
        // ---- RELOAD BRANCH: alive-mpv loadfile (processActive === true) ----
        // PR 3.2e: reload_branch advances phase to reloading{streamLoaded:false},
        // and deriveIsReadyToReveal(reloading{streamLoaded:false}) === false
        // — no setIsReadyToReveal(false) needed.
        dispatchPhase({ type: "reload_branch" });
        // @bugfix mpv-quality-reload-restarts-at-0
        // Carry the resume position ON the loadfile (per-load `start=`), exactly
        // like the backdrop→stream swap above (~L1625). Pre-fix this reload
        // loadfile carried no start, so position was restored ONLY by the
        // ensureExternalSeek below — which is gated on isReadyToReveal, and the
        // `setIsReadyToReveal(false)` on the line above makes that gate BLOCK the
        // restore-seek (it reopens at ~L1964, AFTER the seek). The result was an
        // intermittent restart-from-0 on quality/audio reload. Setting start on
        // the loadfile makes restore atomic and independent of the seek gate;
        // the ensureExternalSeek below stays as a harmless same-position fallback.
        // buildLoadfileCommand only emits `start=` when startTime > 0, so the
        // "start over" (null/0) case still plays from the beginning.
        // @bugfix @regression-proof issue #25 P18: carry the OSC-picked aid/sid
        // (pre-fix this loadfile reverted to mpv's default audio track).
        const reloadTrackOptions = loadTrackOptions();
        // @bugfix @regression-proof issue #25 P19 (c004): the master lists
        // every rung, and without a per-load `hls-bitrate` mpv re-picked the
        // launch-time `--hls-bitrate` rung — an ABR or manual switch to 480p
        // came back on 1080p. Offline files are one muxed stream: no rung.
        const reloadFormatId = isOfflineSource ? null : (effectiveFormat?.id ?? null);
        const reloadHlsBitrateBps = reloadFormatId === null ? null : hlsVariantBandwidthBps(effectiveFormat?.bitrateKbps);
        mpvLog.info({ ...reloadTrackOptions, reloadFormatId, reloadHlsBitrateBps, startTime: options.startTime }, "loadStream: reload loadfile track options");
        fallbackWatch = watchHlsMasterFallback(window.sf?.onMpvExternalMessage, (info) => {
          mpvLog.info({ ...info, branch: "reload" }, "loadStream: reload saw mpv end-file");
        });
        // The replaced file's frame no longer counts: downshifts wait for
        // this load's own first frame. @bugfix @regression-proof issue #25 N4
        noteReloadStarted(abrCtrl);
        // Armed BEFORE the loadfile: on a slow reply the file-loaded (or an
        // end-file / exit) can beat it (issue #25 P15).
        let resolveReloadFileLoaded: () => void = () => {};
        const reloadFileLoaded = new Promise<void>((resolve) => {
          resolveReloadFileLoaded = resolve;
        });
        stopWatchingReloadFileLoaded = window.sf?.onMpvExternalMessage?.((msg) => {
          if (msg.type !== "file_loaded") return;
          // The pushed time-pos may still hold the old file's value until the
          // next throttled push: drop it so the poll reads mpv live.
          observedTimePosRef.current = null;
          pendingStart.loadLanded();
          resolveReloadFileLoaded();
          mpvLog.info({ pendingStart: pendingStart.get() }, "loadStream: reload saw mpv file-loaded — polled position is the new file's");
        });
        // @bugfix @regression-proof issue #25 P15: a reload loadfile whose
        // reply missed the 1 s request timeout used to be read as "mpv is
        // dead" and closed playback while mpv was alive and loading. mpv is
        // dead only when its process exits or its socket is gone; a timed-out
        // reply waits for file-loaded / end-file / exit (awaitReloadLoadfile).
        const reloadStartMs = Date.now();
        let resolveReloadEndFile: (verdict: ExternalLoadVerdict) => void = () => {};
        let resolveReloadExit: (detail: string) => void = () => {};
        const reloadEndFileFailure = new Promise<ExternalLoadVerdict>((resolve) => {
          resolveReloadEndFile = resolve;
        });
        const reloadProcessExited = new Promise<string>((resolve) => {
          resolveReloadExit = resolve;
        });
        // Armed before the loadfile, so the replaced file's end-file can
        // arrive first: only the new entry's end-file judges the reload.
        const reloadEndFileFilter = createNewEntryEndFileFilter();
        const stopWatchingReloadSettle = window.sf?.onMpvExternalMessage?.((msg) => {
          if (msg.type === "exit") {
            mpvLog.warn({ sinceLoadfileMs: Date.now() - reloadStartMs }, "loadStream: mpv process exited while the reload loadfile was settling");
            resolveReloadExit("mpv process exited while the reload loadfile was settling");
            return;
          }
          if (msg.type === "start_file") {
            reloadEndFileFilter.startFile(msg.playlistEntryId);
            mpvLog.info({ playlistEntryId: msg.playlistEntryId, sinceLoadfileMs: Date.now() - reloadStartMs }, "loadStream: reload saw mpv start-file for the new entry");
            return;
          }
          if (msg.type !== "end_file") return;
          const endEntryId = msg.playlistEntryId ?? null;
          if (!reloadEndFileFilter.isNewEntry(endEntryId)) {
            mpvLog.info({ reason: msg.reason, fileError: msg.fileError, endEntryId, ...reloadEndFileFilter.state() }, "loadStream: reload ignoring end-file of the replaced file");
            return;
          }
          const verdict = classifyExternalLoadSignal({ kind: "end_file", reason: msg.reason, fileError: msg.fileError });
          if (verdict.failed) resolveReloadEndFile(verdict);
        });
        const sendReloadLoadfile = () =>
          sendExternalCommandReply(
            buildLoadfileCommand(session.url, "replace", {
              startSeconds: options.startTime ?? null,
              ...reloadTrackOptions,
              hlsBitrateBps: reloadHlsBitrateBps,
            }),
          );
        let reload: ReloadLoadfileOutcome;
        try {
          reload = await awaitReloadLoadfile({
            reply: sendReloadLoadfile(),
            resend: sendReloadLoadfile,
            fileLoaded: reloadFileLoaded,
            endFileFailure: reloadEndFileFailure,
            processExited: reloadProcessExited,
            probeIdleActive: () => sendExternalRequest(buildGetPropertyCommand("idle-active")),
          });
        } finally {
          stopWatchingReloadSettle?.();
        }
        mpvLog.info({
          loadfileMs: Date.now() - reloadStartMs,
          settledBy: reload.settledBy,
          failed: reload.verdict.failed,
          verdictCause: reload.verdict.failed ? reload.verdict.cause : null,
          verdictDetail: reload.verdict.failed ? reload.verdict.detail : reload.verdict.why,
          transportRetries: reload.transportRetries ?? 0,
          probeReply: reload.probeReply ?? null,
          lifecycleKind: lifecycleRef.current.kind,
        }, "loadStream: reload loadfile settled");
        if (reload.verdict.failed) {
          // mpv exited, its socket is gone, it rejected the file or it hangs.
          // The main-process reducer moves the lifecycle to idle on exit /
          // socket loss; the next attempt then takes the launch branch.
          throw new Error("playback_external_loadfile_failed");
        }
        // Build metadata payload up-front so the ready-gate knows expected
        // subtitle / chapter counts.
        const reloadMetadataPayload = await buildExternalMetadataPayload();
        // Phase 1: parallel metadata send + tracks-stable wait. Adaptive
        // backoff (0/100/300 ms) — shared with backdrop and direct-launch
        // branches via the pure helper. Replaces the previous fixed
        // 200 ms × 3 = 600 ms of dead time. The metadata send deliberately
        // overlaps with reloadTracksStablePromise via Promise.all below —
        // DO NOT inline `waitForExternalTracksStable` ahead of this helper
        // call (that's the backdrop branch's serialized ordering, distinct
        // from this path).
        const reloadTracksStablePromise = waitForExternalTracksStable();
        const reloadMetadataPromise = sendMetadataWithBackoff(() => sendExternalMetadataUnchecked(reloadMetadataPayload));
        // Raced with the HLS master fallback watch (issue #25 P8), as in the
        // direct launch above: the x002 ABR reload fell back a second time.
        const reloadPhase1 = await Promise.race([
          Promise.all([reloadTracksStablePromise, reloadMetadataPromise]).then(([stable]) => ({ ready: stable })),
          fallbackWatch.failure,
        ]);
        if ("failed" in reloadPhase1) return await failOnHlsMasterFallback(reloadPhase1, "reload", session.url);
        const { ready } = reloadPhase1;
        const recoveredReady = await confirmExternalPlaybackReady();
        if (!isExternalActive(lifecycleRef.current)) {
          // mpv was stopped (user stop, dialog close) while this reload was
          // in flight: the readiness gates below would all bail on the dead
          // player and warn as if the stream were broken.
          mpvLog.info({ lifecycleKind: lifecycleRef.current.kind }, "loadStream: mpv stopped during the reload — abandoning it");
          throw new Error(PLAYBACK_LOAD_STOPPED);
        }
        if (!shouldTreatRecoveredExternalStateAsReady(ready, recoveredReady)) {
          mpvLog.warn({ logFile: null }, "external not ready after loadfile");
        }
        const lateReloadFallback = fallbackWatch.current();
        if (lateReloadFallback) await failOnHlsMasterFallback(lateReloadFallback, "reload", session.url);
        // @bugfix @regression-proof issue #25 P18-aid2: mpv can ignore the
        // per-load `aid` (c061 logged `aid=2` and still selected aid 1).
        // Compare the live tracks with the carried picks and set them again.
        // @bugfix @regression-proof issue #25 P3 (S2 x007): gate on the picks
        // held NOW, not the pre-load snapshot — a pick made while the
        // loadfile was in flight is not in `reloadTrackOptions`.
        if (oscTrackPicksRef.current.hasPicks(fileIdRef.current)) {
          const [liveAid, liveSid] = await Promise.all([
            getProperty(sendExternalRequest, "aid"),
            getProperty(sendExternalRequest, "sid"),
          ]);
          const unhonored = oscTrackPicksRef.current.unhonored(fileIdRef.current, { aid: liveAid, sid: liveSid });
          for (const pick of unhonored) {
            mpvLog.warn({
              property: pick.property,
              picked: pick.value,
              liveAid,
              liveSid,
            }, "loadStream: mpv did not apply the OSC track pick on reload — setting it again");
            await sendExternalCommandUnchecked(buildSetPropertyCommand(pick.property, pick.value));
          }
        }
        // @bugfix @regression-proof issue #25 P19: mpv can ignore a per-load
        // option (P18-aid2), so check the rung it actually plays and point
        // `vid` at the reload's format if it landed elsewhere.
        if (reloadFormatId !== null) {
          const [liveVid, reloadTrackList] = await Promise.all([
            getProperty(sendExternalRequest, "vid"),
            getProperty(sendExternalRequest, "track-list"),
          ]);
          const expectedVid = findHlsVariantVid(
            Array.isArray(reloadTrackList) ? reloadTrackList : [],
            hlsMasterFormats,
            reloadFormatId,
          );
          mpvLog.info({ reloadFormatId, reloadHlsBitrateBps, liveVid, expectedVid }, "loadStream: reload rung check");
          if (expectedVid !== null && liveVid !== expectedVid) {
            mpvLog.warn({ reloadFormatId, liveVid, expectedVid }, "loadStream: mpv did not play the reload's rung — setting vid");
            await sendExternalCommandUnchecked(buildSetPropertyCommand("vid", expectedVid));
          }
        }
        // [reload-pos] The loadfile above carried the reload's start as a
        // per-load `start=` (@bugfix mpv-quality-reload-restarts-at-0), so the
        // only seek left is one the user made (app or OSC) while the reload
        // was in flight: it wins over the older start.
        // @bugfix @regression-proof issue #25 P1b (S1 c055). It goes to mpv
        // directly: `seeksAllowed(phase)` stays false until
        // `stream_loadfile_done` (after the vo wait below), so
        // ensureExternalSeek would drop it — but phase 1 above already waited
        // for the new file's tracks, so mpv can take the seek now.
        const reloadSeek = pendingStart.takeReloadSeek(options.startTime);
        mpvLog.info({
          startTime: options.startTime,
          reloadSeek,
          seekTarget: seekTargetRef.current,
          lastKnownTime: lastKnownTimeRef.current,
          phaseKind: phaseRef.current.kind,
        }, "[reload-pos] reload loadfile done — restoring a seek made during the reload, if any");
        if (reloadSeek !== null) {
          const sent = await sendExternalCommand(buildSeekCommand(reloadSeek, "absolute", "exact"));
          mpvLog.info({ reloadSeek, sent }, "[reload-pos] seek made during the reload sent to the new file");
        }
        const shouldPlay = !options.paused;
        lastSentPauseRef.current = { value: true, at: Date.now() };
        await sendExternalCommandUnchecked(buildSetPropertyCommand("pause", true));
        // Phase 2: ready-gate — wait for vo-configured (first frame on
        // screen). Metadata-applied is best-effort and runs in the
        // background so reload doesn't stretch the wait when there are
        // many external subtitles.
        const RELOAD_READY_GATE_BUDGET_MS = 5000;
        const reloadGateStart = Date.now();
        void waitForMetadataApplied(
          {
            expectedExternalSubtitles: reloadMetadataPayload.subtitles.length,
            expectedChapters: reloadMetadataPayload.chapters.length,
          },
          RELOAD_READY_GATE_BUDGET_MS,
        ).then((applied) => {
          if (!applied) {
            mpvLog.warn(
              { elapsedMs: Date.now() - reloadGateStart },
              "loadfile metadata not fully applied within budget (best-effort)",
            );
          }
        });
        const reloadVoReady = await waitForVoConfigured(RELOAD_READY_GATE_BUDGET_MS);
        if (!reloadVoReady) {
          mpvLog.warn(
            { elapsedMs: Date.now() - reloadGateStart },
            "loadfile vo-configured did not fire before budget; revealing mpv anyway",
          );
        }
        // Skip the hide if mpv exited mid-gate — see Phase-2 comment in the
        // launch branch above.
        if (isExternalActive(lifecycleRef.current)) {
          try {
            await window.sf?.signalPlaybackReady?.();
          } catch (err) {
            mpvLog.warn(
              { message: err instanceof Error ? err.message : String(err) },
              "signalPlaybackReady failed",
            );
          }
        } else {
          mpvLog.info("skipping signalPlaybackReady (loadfile) — mpv exited during gate");
        }
        if (shouldPlay) {
          await resumeExternalPlayback({ auto: true });
          setBufferingImmediate(false);
          // A user pause made during the reload stays shown as paused.
          setIsPlaying(
            autoPlayAllowed({ playRequestedAt: playRequestedAtRef.current, userPausedAt: userPausedAtRef.current }),
          );
          holdStartupState(1500);
        }
        // Reload-on-alive-mpv: the stream is loaded by definition (mpv
        // was already playing a stream before this loadfile, and the
        // loadfile replaced it with another stream). Open the seek gate
        // explicitly so a mid-reload seek invocation doesn't get blocked.
        // PR 3.2d + 3.2e: dispatch advances reloading{streamLoaded:false} →
        // reloading{streamLoaded:true} (seeksAllowed=true; deriveIsReadyToReveal=true);
        // the `load_settled` below in the `finally` then advances to playing.
        dispatchPhase({ type: "stream_loadfile_done" });
        // The new stream starts with an empty buffer and an estimator still
        // measuring the old variant: hold ABR downshifts for a while.
        // @bugfix @regression-proof issue #25 P8
        noteSwitchSettled(abrCtrl, Date.now());
        return;
      }
      } finally {
        fallbackWatch?.stop();
        stopWatchingReloadFileLoaded?.();
        // Backstop: a failed or abandoned load must not leave the poll
        // ignoring every sample.
        pendingStart.loadLanded();
        pendingStart.reloadSettled();
        // PR 3.2c-3: launchInProgressRef cleanup is gone — load_settled
        // advances the phase out of `launching` / `reloading{streamLoaded:true}`
        // → `playing`, which `isLoadInFlight(phase)` reads as not-in-flight.
        // Direct/backdrop paths: this is a no-op (already playing).
        // Reload path: slight-early release per plan W3.
        dispatchPhase({ type: "load_settled" });
        mpvLog.info({
          lifecycleKind: lifecycleRef.current.kind,
        }, "loadStream: exit (latch released)");
      }
    },
    [
      // Facade-owned IPC helpers (lib/useExternalMpvCommands.ts, PR 4.1).
      // Each useCallback inside the facade has stable identity (its own
      // deps are all refs or stable callbacks), so listing them
      // individually here doesn't churn loadStream's identity.
      sendExternalCommand,
      sendExternalCommandReply,
      sendExternalCommandRaw,
      sendExternalCommandUnchecked,
      sendExternalRequest,
      sendExternalRequestRaw,
      waitForExternalTracksStable,
      waitForVoConfigured,
      waitForMetadataApplied,
      confirmExternalPlaybackReady,
      ensureExternalSeek,
      // Engine-owned helpers + state.
      createHlsSession,
      effectiveFormat?.bitrateKbps,
      effectiveFormat?.id,
      hlsMasterFormats,
      buildExternalMetadataPayload,
      holdStartupState,
      releaseHlsSession,
      sendExternalMetadata,
      sendExternalMetadataUnchecked,
      resumeExternalPlayback,
      setBufferingImmediate,
      setExternalMpvSessionActive,
      dispatchPhase,
      pendingStart,
    ]
  );

  const setPaused = useCallback(
    async (paused: boolean) => {
      if (paused) {
        lastSentPauseRef.current = { value: true, at: Date.now() };
        const applied = await sendExternalCommand(buildSetPropertyCommand("pause", true));
        if (applied && (await waitForExternalPause(true))) {
          return;
        }
        await sendExternalCommandRaw(buildSetPropertyCommand("pause", true));
        await waitForExternalPause(true);
        return;
      }
      notePlayRequest();
      await resumeExternalPlayback();
    },
    [resumeExternalPlayback, sendExternalCommand, sendExternalCommandRaw, waitForExternalPause]
  );

  const pauseForChange = useCallback(
    async (action: () => Promise<void>) => {
      if (Date.now() < startupHoldUntilRef.current) {
        await action();
        return;
      }
      // @bugfix @regression-proof pause-for-change-idle-dead-wait
      // No live mpv (e.g. "Start over" from the resume prompt after the prior
      // player exited): there is nothing to pause, and the pause dance would
      // sleep 2 × 3 s (waitForExternalPause polling a player that does not
      // exist) before loadStream could even launch mpv. loadStream owns the
      // buffering/isPlaying state for the fresh launch.
      if (!hasLiveExternalPlayer(lifecycleRef.current, mpvFlagsRef.current.externalPlayer)) {
        mpvLog.info(
          { lifecycleKind: lifecycleRef.current.kind },
          "pauseForChange: no live external player — running action without pausing",
        );
        await action();
        return;
      }
      const shouldResume = !userPausedRef.current && !blockAutoPlayRef.current;
      holdManualState(600);
      setBufferingImmediate(true);
      setIsPlaying(false);
      let pausedByUs = false;
      try {
        await setPaused(true);
        pausedByUs = true;
        await waitForExternalPause(true);
      } catch {
        // If we fail to confirm pause, keep going and attempt to recover in finally.
      }
      try {
        await action();
      } finally {
        if (shouldResume && pausedByUs) {
          const resumeTime = seekTargetRef.current ?? lastKnownTimeRef.current;
          if (Number.isFinite(resumeTime) && !isExternalZeroSeek(resumeTime)) {
            await ensureExternalSeek(resumeTime);
          }
        }
        if (shouldResume && pausedByUs) {
          await setPaused(false);
          setIsPlaying(true);
        }
        setBufferingImmediate(false);
      }
    },
    [
      blockAutoPlayRef,
      lifecycleRef,
      mpvFlagsRef,
      ensureExternalSeek,
      holdManualState,
      startupHoldUntilRef,
      setBufferingImmediate,
      setPaused,
      waitForExternalPause,
    ]
  );


  const teardownPlayer = useCallback(async () => {
    const ignoredDuringLaunch = shouldIgnoreExternalTeardownDuringLaunch(
      externalLaunchStartedAt(lifecycleRef.current),
      isExternalReady(lifecycleRef.current)
    );
    // Every renderer-side mpv stop names its cause (issue #25 S1 c038: a stop
    // 49 ms after the window hide could not be attributed). The controller
    // logs why playback closed ("MediaPlaybackController: closing playback").
    mpvLog.info({
      stopCause: "playback-closed",
      ignoredDuringLaunch,
      phaseKind: phaseRef.current.kind,
      lifecycleKind: lifecycleRef.current.kind,
    }, ignoredDuringLaunch
      ? "teardown: playback closed during the launch grace — mpv kept"
      : "teardown: playback closed — stopping external mpv");
    if (ignoredDuringLaunch) return;
    await window.sf?.stopExternalMpv?.().catch(() => null);
    // Lifecycle bookkeeping is owned by the main-process reducer — it
    // dispatches user_stop / process_exited during stopExternalMpv and the
    // resulting state lands on this engine via the subscribeLifecycle push.
    await releaseHlsSession(hlsSessionRef.current);
    hlsSessionRef.current = null;
    await releaseOfflineSession(offlineSessionRef.current);
    offlineSessionRef.current = null;
    offlineSubtitleKeysRef.current = null;
    // ACCT-STREAM-04: the player closed, so its stream place goes back at once.
    void releaseDesktopStreamSlot();
  }, [releaseHlsSession, releaseOfflineSession]);

  useEffect(() => {
    const shouldTeardown = shouldTeardownExternalPlayback(wasOpenRef.current, open);
    wasOpenRef.current = open;
    if (shouldTeardown) {
      void teardownPlayer();
      setStreamError(null);
      setBufferingImmediate(false);
      setIsPlaying(false);
      // PR 3.2d + 3.2e: user-initiated teardown (dialog close / engine
      // remount). Phase → stopping (deriveIsReadyToReveal=false); the
      // lifecycle subscription dispatches process_gone separately when
      // mpv exits, taking phase to idle. The phase predicates re-arm
      // both the seek gate and the public reveal value atomically.
      dispatchPhase({ type: "user_stop" });
      setAppendProgress(0);
      setCurrentTime(0);
      setBufferedTime(0);
    }
  }, [dispatchPhase, open, setBufferingImmediate, teardownPlayer]);

  const loadStreamRef = useRef(loadStream);

  useEffect(() => {
    loadStreamRef.current = loadStream;
  }, [loadStream]);

  // Settle a pending format switch on an init exit that does not reload.
  // `resume`: mpv is already playing the right stream, so the only thing
  // left of the switch is the pause selectFixedFormat issued — undo it
  // unless the user paused. Never leave mpv paused on the app's behalf.
  // @bugfix @regression-proof issue #25 c035 / c065
  const settleFormatSwitchWithoutReload = useCallback(
    (reason: FormatSwitchSettleReason, resume: boolean) => {
      const settled = formatSwitch.settle();
      if (!settled) return;
      const shouldResume =
        resume && settled.resumeAutoplay && !userPausedRef.current && !blockAutoPlayRef.current;
      mpvLog.info({
        switchId: settled.id,
        source: settled.source,
        formatId: settled.formatId,
        reason,
        shouldResume,
        userPaused: userPausedRef.current,
        blockAutoPlay: blockAutoPlayRef.current,
      }, "format switch: settled without reload");
      setBufferingImmediate(false);
      if (shouldResume) {
        setIsPlaying(true);
        void setPaused(false);
      }
    },
    [formatSwitch, setBufferingImmediate, setPaused],
  );

  const initRunCountRef = useRef(0);
  useEffect(() => {
    if (!open || !fileId || !effectiveFormatMap || !playerReady) return;
    // Hard guard: if a load is already in flight, do nothing. The init
    // effect itself can re-fire from dep changes mid-launch — most commonly
    // when the optimistic-update cascade (libraryContext.tsx:1496-1500 →
    // MediaDetailsDialog's line 451 effect → playbackMedia memo →
    // setCurrentMedia in the controller) ripples a new `media` prop into
    // the engine, which flips audioMapSignature / effectiveFormatSignature.
    // Pre-fix the re-fired init() called loadStream a second time, entered
    // the loadfile branch on the now-alive mpv, and triggered a sequential
    // reload — the 3 s loop the user saw.
    //
    // Skipping the entire init body when a load is in flight closes that
    // hole without changing any data-flow architecture (the optimistic UX
    // is preserved). After the load completes (load_settled advances phase
    // to `playing`) any legitimate later dep changes re-fire init normally.
    //
    // @bugfix mpv-launch-init-effect-sequential-refire (phase-resolved in 3.2c-3)
    // @bugfix mpv-launch-loop-from-controller-mount-storm (phase-resolved in 3.2c-3)
    // @bugfix @regression-proof issue #25 c035: a format switch that lands
    // while a load is in flight is QUEUED, not dropped — it re-fires this
    // effect (formatSwitchRetryNonce) once the load settles. Pre-fix the
    // skip below dropped it and mpv stayed paused by selectFixedFormat.
    //
    // Post-launch re-fire guard: if mpv is alive AND the current
    // (fileId, audioMapSignature, effectiveFormatSignature) tuple matches
    // the most recently launched tuple, skip. This catches re-fires
    // queued by a dep change that arrived DURING the launch (e.g. a
    // runtime SSE `badger.library.updated` snapshot pushed mid-launch
    // resets `mediaDetailsMap` → ripples a new playbackMedia memo →
    // new media prop → flips audioMapSignature). Without this guard the
    // re-fired effect calls loadStream on alive mpv → loadfile branch →
    // segment reload — the user-observed 3-10 s loop. Note: matched
    // skips are intentionally idempotent — the tuple covers everything
    // loadStream consumes, so re-running would produce no visible
    // change other than the spurious reload. A pending switch whose
    // target is already loaded is settled and mpv resumed.
    //
    // @bugfix mpv-launch-init-effect-post-launch-refire
    const currentKey = `${fileId}|${effectiveFormatSignature}|${audioMapSignature}`;
    const pendingSwitchAtEntry = formatSwitch.get();
    const entryDecision = decideInitEntry({
      loadInFlight: isLoadInFlight(phaseRef.current),
      switchPending: pendingSwitchAtEntry !== null,
      matchesLastLaunchedKey:
        mpvFlagsRef.current.externalPlayer &&
        isExternalActive(lifecycleRef.current) &&
        phaseRef.current.lastLaunchedKey === currentKey,
    });
    if (entryDecision !== "proceed") {
      mpvLog.info({
        entryDecision,
        lifecycleKind: lifecycleRef.current.kind,
        open,
        fileId,
        phaseKind: phaseRef.current.kind,
        currentKey,
        switchId: pendingSwitchAtEntry?.id ?? null,
        switchSource: pendingSwitchAtEntry?.source ?? null,
        retryNonce: formatSwitchRetryNonce,
      }, entryDecision === "skip-load-in-flight"
        ? "init effect: skip (load already in flight)"
        : entryDecision === "defer-switch-until-settled"
          ? "init effect: load in flight — format switch queued until it settles"
          : entryDecision === "skip-matches-last-launched-key"
            ? "init effect: skip (matches last-launched key)"
            : "init effect: format switch target already loaded — settling + resuming");
      if (entryDecision === "defer-switch-until-settled") {
        formatSwitch.defer();
        setFormatSwitchDeferTick((value) => value + 1);
      } else if (entryDecision === "settle-switch-already-loaded") {
        settleFormatSwitchWithoutReload("already-loaded", true);
      }
      return;
    }
    // @bugfix mpv-launch-init-effect-pre-loadstream-window (phase-resolved)
    //
    // PR 3.2c-2: dispatch `start_load` SYNCHRONOUSLY here, before any
    // await. The phase reducer advances to `launching` (or `reloading` if
    // current state is `playing`); subsequent dep-change re-fires of the
    // init effect read `isLoadInFlight(phaseRef.current) === true` at
    // the top guard above and short-circuit BEFORE any side effect.
    // This closes the pre-loadStream-await window that the original
    // initEffectInFlightRef latch was added to fix. The latch ref itself
    // is gone (PR 3.2c-3).
    //
    // The 4 early-return branches below (smokeTest, deferPlayback,
    // blockAutoPlayRef-with-startTime, pendingIntent-consume) each
    // dispatch `cancel_load` before their `return` so phase is rolled
    // back instead of stuck in `launching` forever.
    dispatchPhase({
      type: "start_load",
      intent: phaseRef.current.lastConsumedIntent ?? "auto",
    });
    const { smokeTest, externalPlayer } = mpvFlagsRef.current;
    const debugTiming = import.meta.env.DEV && import.meta.env.VITE_DEBUG;
    const timingStart = performance.now();
    let cancelled = false;
    initRunCountRef.current += 1;
    const initRun = initRunCountRef.current;
    mpvLog.info({
      initRun,
      lifecycleKind: lifecycleRef.current.kind,
      fileId,
      open,
      playerReady,
    }, "init effect: fire");
    const init = async () => {
      if (debugTiming) {
        mpvLog.debug({
          fileId,
          playerReady,
          externalPlayer,
        }, "init timing start");
      }
      setStreamError(null);
      setBufferingImmediate(!smokeTest);
      setAppendProgress(0);
      await window.sf?.setPlaybackToken?.(token ?? null).catch(() => null);
      if (debugTiming) {
        mpvLog.debug({ elapsedMs: Math.round(performance.now() - timingStart) }, "init timing token");
      }
      setPlayerSession((value) => value + 1);
      if (smokeTest) {
        mpvLog.info({}, "smoke test: init only");
        setIsPlaying(false);
        setBufferedTime(0);
        setCurrentTime(0);
        // PR 3.2c-2: rollback the start_load dispatch from the init-effect
        // top — this branch never calls loadStream, so no
        // stream_loadfile_done / load_settled will advance phase.
        dispatchPhase({ type: "cancel_load" });
        settleFormatSwitchWithoutReload("smoke-test", false);
        return;
      }
      if (deferPlayback) {
        setBufferingImmediate(false);
        setIsPlaying(false);
        setAppendProgress(0);
        // PR 3.2c-2: rollback — no loadStream call below.
        dispatchPhase({ type: "cancel_load" });
        settleFormatSwitchWithoutReload("playback-deferred", false);
        return;
      }
      // @bugfix @regression-proof issue #25 s1:x002: a format switch on a
      // live mpv resumes at mpv's LIVE time-pos, read now. An OSC seekbar
      // seek happens inside mpv, so the renderer's polled time (and any
      // value captured when the switch was requested) can lag it — x002
      // reloaded at 1.938 s right after a seek to 55 s. A pending start
      // target (PR #81) still wins over the pre-seek time-pos.
      const pendingSwitch = formatSwitch.get();
      let resumeTime = seekTargetRef.current ?? lastKnownTimeRef.current;
      if (pendingSwitch && externalPlayer && isExternalActive(lifecycleRef.current)) {
        const timePos = await getProperty(sendExternalRequest, "time-pos");
        const capturedTime = typeof timePos === "number" ? timePos : null;
        const pendingStartTime = pendingStart.get();
        const loadInFlight = pendingStart.isLoadInFlight();
        const liveStart = resolveReloadStartTime({
          pendingStart: pendingStartTime,
          capturedTime,
          seekTarget: seekTargetRef.current,
          lastKnownTime: lastKnownTimeRef.current,
          loadInFlight,
        });
        // Positions first: the renderer console preview keeps ~5 fields.
        mpvLog.info({
          liveStart,
          capturedTime,
          pendingStart: pendingStartTime,
          loadInFlight,
          requestedResume: resumeTime,
          switchId: pendingSwitch.id,
          source: pendingSwitch.source,
          formatId: pendingSwitch.formatId,
        }, "format switch: reload position read live from mpv");
        if (liveStart !== null) {
          resumeTime = liveStart;
          lastKnownTimeRef.current = liveStart;
          seekTargetRef.current = liveStart;
        }
      }
      const startTime = Number.isFinite(resumeTime) ? resumeTime : null;
      const shouldAutoPlay = (autoPlayRef.current || resumeTime === 0) && !blockAutoPlayRef.current;
      autoPlayRef.current = shouldAutoPlay;
      userPausedRef.current = !shouldAutoPlay;
      // A pause made in mpv from here on (launch, handoff, seek) beats this start.
      if (shouldAutoPlay) notePlayRequest();
      setBufferingImmediate(true);
      if (cancelled) {
        // PR 3.2c-2: React-unmount mid-init — rollback the start_load
        // dispatch so the next mount doesn't observe phase=launching.
        dispatchPhase({ type: "cancel_load" });
        return;
      }
      if (blockAutoPlayRef.current && startTime !== null && startTime > ZERO_SEEK_EPS) {
        setBufferingImmediate(false);
        setIsPlaying(false);
        // PR 3.2c-2: rollback — Resume-prompt path defers loadStream until
        // the user clicks Resume.
        dispatchPhase({ type: "cancel_load" });
        settleFormatSwitchWithoutReload("resume-prompt", false);
        return;
      }
      if (debugTiming) {
        mpvLog.debug({ elapsedMs: Math.round(performance.now() - timingStart) }, "init timing pre-load");
      }
      // PR 3.2b-flip: the manualStart-consume guard now reads
      // `phase.lastConsumedIntent`. The two ref-based guards (manualStart
      // + skipExternalInit) collapse here because the intent value
      // distinguishes them: `userManual` means startFrom-without-seek (rare),
      // `userZeroSeek` means startFrom-zero-seek. Both warrant short-
      // circuiting the init effect's own loadStream call.
      // @bugfix @regression-proof issue #25 c065: a pending format switch
      // still reloads. startFrom's zero-seek path can leave `userZeroSeek`
      // parked; pre-fix the switch's re-fire consumed it here and returned
      // without loadStream, leaving mpv paused by selectFixedFormat.
      const pendingIntent = phaseRef.current.lastConsumedIntent;
      const intentDecision = decideIntentConsume({
        pendingIntent,
        externalActive: externalPlayer && isExternalActive(lifecycleRef.current),
        switchPending: pendingSwitch !== null,
      });
      if (intentDecision === "consume-intent-and-skip") {
        lastReloadSignatureRef.current = `${effectiveFormatSignature}|${audioMapSignature}`;
        dispatchPhase({
          type: "set_reload_signature",
          signature: `${effectiveFormatSignature}|${audioMapSignature}`,
        });
        // PR 3.2c-2: rollback the start_load dispatch from init-effect top
        // (no loadStream call below). cancel_load is dispatched FIRST so
        // phase rolls back to playing/idle while lastConsumedIntent is
        // still set; then consume_intent clears the intent field.
        dispatchPhase({ type: "cancel_load" });
        dispatchPhase({ type: "consume_intent" });
        setBufferingImmediate(false);
        return;
      }
      if (intentDecision === "consume-intent-and-load") {
        mpvLog.info({
          pendingIntent,
          switchId: pendingSwitch?.id,
          source: pendingSwitch?.source,
        }, "init: consuming stale startFrom intent — format switch still reloads");
        dispatchPhase({ type: "consume_intent" });
      }
      skipReloadRef.current = true;
      lastReloadSignatureRef.current = `${effectiveFormatSignature}|${audioMapSignature}`;
      // [playbackPhase] Shadow-mount (PR 3.1b): pre-loadStream
      // reload-signature stamp.
      dispatchPhase({
        type: "set_reload_signature",
        signature: `${effectiveFormatSignature}|${audioMapSignature}`,
      });
      mpvLog.info({
        initRun,
        lifecycleKind: lifecycleRef.current.kind,
        phaseKind: phaseRef.current.kind,
        willCallLoadStream: true,
        switchId: pendingSwitch?.id ?? null,
        startTime,
        shouldAutoPlay,
      }, "init: about to call loadStream");
      await loadStreamRef.current({ startTime, paused: !shouldAutoPlay });
      if (pendingSwitch) {
        const settled = formatSwitch.settle(pendingSwitch.id);
        mpvLog.info({
          switchId: pendingSwitch.id,
          source: pendingSwitch.source,
          formatId: pendingSwitch.formatId,
          settled: settled !== null,
          newerSwitchQueued: settled === null ? formatSwitch.get()?.id ?? null : null,
          startTime,
        }, "format switch: reloaded");
      }
      // Stamp the launched tuple so a subsequent init re-fire (from a
      // dep change queued mid-launch — typically the runtime SSE snapshot
      // arriving during the 5-10s launch ready-gate) can short-circuit
      // at the top guard instead of entering the loadfile reload branch.
      // PR 3.2a: the stamp now lives in `phase.lastLaunchedKey`; the
      // reducer is the sole writer (this dispatch) and the init guard
      // above reads it directly.
      // @bugfix mpv-launch-init-effect-post-launch-refire
      dispatchPhase({
        type: "stamp_launched_key",
        key: `${fileId}|${effectiveFormatSignature}|${audioMapSignature}`,
      });
      if (debugTiming) {
        mpvLog.debug({ elapsedMs: Math.round(performance.now() - timingStart) }, "init timing post-load");
      }
      if (!externalPlayer) {
        setIsPlaying(shouldAutoPlay);
      }
    };
    void init()
      .catch((error) => reportLoadFailure(error, "init", !cancelled))
      .finally(() => {
        // PR 3.2c-3: the init-in-flight latch release is gone. Phase
        // transitions out of `launching` via load_settled (loadStream's
        // finally), load_failed (catch above), or cancel_load (the 4
        // early-return branches). `isLoadInFlight(phase)` returns false
        // once any of those fired, so legitimate later dep changes
        // re-fire init normally without needing a flag-write here.
        mpvLog.info({
          initRun,
          lifecycleKind: lifecycleRef.current.kind,
          phaseKind: phaseRef.current.kind,
        }, "init effect: complete");
      });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    fileId,
    initSignature,
    playerReady,
    t,
    reportLoadFailure,
    deferPlayback,
    setBufferingImmediate,
    audioMapSignature,
    effectiveFormatSignature,
    dispatchPhase,
    formatSwitchRetryNonce,
  ]);

  const lastReloadSignatureRef = useRef<string | null>(null);
  const skipReloadRef = useRef(false);

  useEffect(() => {
    if (!open || !playerSession) return;
    if (mpvFlagsRef.current.smokeTest) return;
    if (mpvFlagsRef.current.externalPlayer) return;
    if (deferPlayback) return;
    // Silent media has no audio map: only require it when audio exists.
    if (
      !isPlaybackReloadReady({
        effectiveFormatMap: effectiveFormatMapRef.current,
        audioMap: audioMapRef.current,
        hasPlayableAudio,
      })
    ) {
      return;
    }
    const signature = `${effectiveFormatSignature}|${audioMapSignature}`;
    if (skipReloadRef.current) {
      skipReloadRef.current = false;
      lastReloadSignatureRef.current = signature;
      return;
    }
    if (lastReloadSignatureRef.current === signature) return;
    lastReloadSignatureRef.current = signature;
    if (import.meta.env.DEV && import.meta.env.VITE_DEBUG) {
      mpvLog.debug({ signature }, "reload signature");
    }
    void pauseForChange(() => runReportingLoadFailure(async () => {
      const timePos = await getProperty(sendExternalRequest, "time-pos");
      const preciseTime = typeof timePos === "number" ? timePos : null;
      const pendingStartTime = pendingStart.get();
      const startTime = resolveReloadStartTime({
        pendingStart: pendingStartTime,
        capturedTime: preciseTime,
        seekTarget: seekTargetRef.current,
        loadInFlight: pendingStart.isLoadInFlight(),
        lastKnownTime: lastKnownTimeRef.current,
      });
      if (pendingStartTime !== null || typeof preciseTime === "number") {
        lastKnownTimeRef.current = startTime ?? lastKnownTimeRef.current;
        seekTargetRef.current = startTime;
      }
      mpvLog.info({
        preciseTime,
        pendingStart: pendingStartTime,
        startTime,
      }, pendingStartTime !== null
        ? "reload: start target still pending — reloading at it, not at pre-seek time-pos"
        : "reload: resuming at captured position");
      await loadStream({ startTime, paused: true });
    }, (error) => reportLoadFailure(error, "reload")));
  }, [
    audioMapSignature,
    hasPlayableAudio,
    sendExternalRequest,
    pendingStart,
    effectiveFormatSignature,
    loadStream,
    open,
    pauseForChange,
    reportLoadFailure,
    playerSession,
    deferPlayback,
  ]);

  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer || !isExternalActive(lifecycle)) return;
    let cancelled = false;
    const applyExternalSubtitle = async () => {
      // "off" branch: user wants no subtitle. mpv's `--alang` and sf.lua's
      // sub-add "auto" flag both default to picking an English (or
      // locale-matching) sub on launch, so we MUST set sid=no eagerly —
      // outside pauseForChange and the cancelled guard — to override mpv's
      // auto-selection. Wrapping in pauseForChange races against the
      // surrounding launch state churn: the effect re-fires when
      // isReadyToReveal flips true, the cleanup sets cancelled=true before
      // the in-flight set-sid lands, and the user ends up seeing whatever
      // mpv autopicked (typically English).
      if (selectedSubtitleId === "off") {
        const result = await sendExternalCommand(buildSetPropertyCommand("sid", "no"));
        if (import.meta.env.DEV) {
          mpvSubtitleLog.debug({ selectedSubtitleId, result }, "apply (off)");
        }
        return;
      }
      const selected = subtitleOptions.find((track) => track.id === selectedSubtitleId);
      if (typeof selected?.objectKey !== "string" || selected.objectKey.length === 0) return;
      const objectKey = selected.objectKey;
      let url = await getPlaybackObjectUrl(objectKey);
      // PLAY-TRACK-07 interim: the launch's late fill is downloading this sidecar; it adds it from disk and selects
      // it if it is still the pick when it lands. A second fetch + sub-add here would race it.
      if (lateSidecarsRef.current?.owns(url)) {
        subPipelineLog.info({ selectedSubtitleId, objectKey }, "apply: sidecar still downloading, the late fill adds it");
        return;
      }
      // Always cache regardless of selected.format: mpv only ever gets a sidecar from disk (a raw proxy URL holds
      // its picture while it reads), and its track-list `external-filename` is that cached path, so the
      // URL-equality check below compares like with like.
      if (window.sf?.cacheExternalMpvSubtitles) {
        const cached = await window.sf.cacheExternalMpvSubtitles([
          {
            url,
            title: selected.label || selected.language || "Subtitle",
            lang: selected.language || "und",
            format: selected.format ?? null,
          },
        ]);
        if (!cached?.[0]?.url) {
          subPipelineLog.warn({ selectedSubtitleId, objectKey }, "apply: subtitle not cached (fetch failed), not handing mpv the raw URL");
          return;
        }
        url = cached[0].url;
      }
      if (cancelled) return;
      // sf.lua already sub-add's every subtitle in the payload during launch
      // (see apply_subtitles_json). Calling sub-add for the same URL a second
      // time from here puts mpv in a state where track-list shows the sub as
      // selected but the render pipeline doesn't pick it up until the user
      // toggles tracks. So: prefer set_property sid against an existing track
      // when there's one, only fall back to sub-add for genuinely new entries
      // (e.g. user picked a sub that wasn't in the original payload).
      const trackListResult = await getProperty(sendExternalRequest, "track-list");
      const trackList: ReadonlyArray<MpvTrack> = Array.isArray(trackListResult) ? trackListResult : [];
      // Compute the expected title using the SAME formatter that
      // buildExternalMetadataPayload uses when sending the payload to sf.lua
      // (line 419) — otherwise the title comparison would compare e.g.
      // mpv's "French" against this side's "fr" and miss every time.
      const expectedTitle = formatPlayerTrackLabel(selected.language, selected.label, "Subtitle");
      const expectedLang = selected.language || "und";
      const existing = findExternalSubtitle(trackList, { url, expectedLang, expectedTitle });
      // CRITICAL: when the track already exists in mpv (sf.lua sub-add'd it
      // during launch), apply `set_property sid` EAGERLY — outside both the
      // `pauseForChange` wrapper and the `cancelled` guard. See history in
      // commits 22cb114b / a252a61a / c829e245.
      if (existing && typeof existing.id === "number") {
        // Bail when sid is already correct. sf.lua now sub-add's the default
        // sub with mpv's "select" flag (sub.selected in the payload), which
        // means sid is set BEFORE the first frame is decoded. If the
        // post-launch effect re-issues `set_property sid` against the same
        // value, mpv still does a refresh-seek — that's the 1–4s replay loop
        // the user reported. Read sid first; only set if it differs.
        const currentSidRaw = await getProperty(sendExternalRequest, "sid");
        const currentSid = typeof currentSidRaw === "number" ? currentSidRaw : null;
        if (currentSid === existing.id) {
          if (import.meta.env.DEV) {
            mpvSubtitleLog.debug({
              selectedSubtitleId,
              trackId: selected.id,
              sid: currentSid,
              reused: true,
            }, "apply: skip (sid already correct)");
          }
          return;
        }
        const sidApplied = await sendExternalCommand(buildSetPropertyCommand("sid", existing.id));
        if (import.meta.env.DEV) {
          const sidResult = await getProperty(sendExternalRequest, "sid");
          mpvSubtitleLog.debug({
            selectedSubtitleId,
            trackId: selected.id,
            trackLabel: selected.label,
            expectedTitle,
            expectedLang,
            format: selected.format ?? null,
            url,
            reused: true,
            sidApplied,
            sidResult,
          }, "apply");
        }
        return;
      }
      // Genuinely new entry (user picked a sub not in the launch payload).
      // sub-add is heavier and decode-blocking. Use mpv's "select" flag so
      // mpv loads + selects in one operation. We deliberately do NOT wrap in
      // pauseForChange — the same race-cancellation problem that affects the
      // "off" branch above applies here. mpv handles sub-add cleanly without
      // a pause; only the loadfile/replace path needs a pause and that's
      // already handled inside loadStream.
      // Titled like the launch payload's entries, so the subtitle menu lists it by name (PLAY-SUBGET-02).
      const addResult = await sendExternalCommand(buildSubAddCommand(url, "select", expectedTitle, expectedLang));
      const sidResult = await getProperty(sendExternalRequest, "sid");
      if (import.meta.env.DEV) {
        mpvSubtitleLog.debug({
          selectedSubtitleId,
          trackId: selected.id,
          trackLabel: selected.label,
          expectedTitle,
          expectedLang,
          format: selected.format ?? null,
          url,
          reused: false,
          addResult,
          sidResult,
        }, "apply");
      }
    };
    void applyExternalSubtitle();
    return () => {
      cancelled = true;
    };
    // isReadyToReveal AND lifecycle are intentionally in the dep array:
    // the effect fires early (when subtitleOptions populate and set
    // selectedSubtitleId to the user's default) at which point mpv isn't
    // alive yet, so the isExternalActive guard bails. Without re-firing on
    // lifecycle/isReadyToReveal, the optimal-sub selection never happens
    // for this playback session — mpv's "auto" pick from sf.lua's sub-add
    // wins and the user's chosen default doesn't render.
  }, [open, playerSession, selectedSubtitleId, subtitleOptions, getPlaybackObjectUrl, sendExternalCommand, sendExternalRequest, isReadyToReveal, lifecycle]);

  // PLAY-TRACK-04: mpv plays the app's audio choice (at play start the title's remembered audio). The HLS master's
  // DEFAULT flag does not choose for mpv and a per-load `aid` can be ignored (P18-aid2), so once the file shows,
  // set `aid` when mpv plays another rendition. An OSC pick of this file wins (it is carried as its own `aid`).
  // The set waits until time-pos is past the stream start: mpv's refresh seek for the new track (time-pos - 1 s)
  // fails before it and the replay stalls or jumps ahead. @bugfix @regression-proof #2762
  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer || !isExternalActive(lifecycle) || !isReadyToReveal) return;
    if (offlineSessionRef.current !== null) return;
    if (oscTrackPicksRef.current.reloadOptions(fileIdRef.current).audioTrack !== null) return;
    const aid = hlsAudioTrackFor(audioOptions, selectedAudioId);
    if (aid === null) return;
    let cancelled = false;
    void (async () => {
      const liveAid = await getProperty(sendExternalRequest, "aid");
      if (liveAid === aid) return;
      const waited = await waitForSafeTrackSwitch(
        () => getProperty(sendExternalRequest, "time-pos"),
        () => cancelled || oscTrackPicksRef.current.reloadOptions(fileIdRef.current).audioTrack !== null,
      );
      if (!waited) return;
      const aidNow = await getProperty(sendExternalRequest, "aid");
      if (cancelled || aidNow === aid) return;
      if (oscTrackPicksRef.current.reloadOptions(fileIdRef.current).audioTrack !== null) return;
      mpvLog.info({ selectedAudioId, aid, liveAid: aidNow, fileId: fileIdRef.current }, "audio apply: mpv plays another rendition than the app's audio choice — setting aid");
      await sendExternalCommandUnchecked(buildSetPropertyCommand("aid", aid));
    })().catch((error: unknown) => {
      mpvLog.warn({ selectedAudioId, aid, error: error instanceof Error ? error.message : String(error) }, "audio apply: aid read/set failed");
    });
    return () => {
      cancelled = true;
    };
  }, [open, lifecycle, isReadyToReveal, audioOptions, selectedAudioId, sendExternalRequest, sendExternalCommandUnchecked]);

  // Tier-4 — observe_property push subscriptions for the 6 push-friendly
  // properties. Gated behind SF_MPV_OBSERVE_PROPERTY=1 so the change can
  // bake in a staged rollout. When on, the poll loop below reads these
  // values from the observed-ref cache instead of issuing 6 extra IPC
  // get_property calls per cycle.
  //
  // KEPT POLLED even when the flag is on: `track-list` and `chapter-list`
  // (Lua mutates these mid-lifecycle via sub-add / set_property_native);
  // `demuxer-cache-time`, `paused-for-cache` (transient or derived state
  // where push wouldn't reduce traffic meaningfully).
  //
  // time-pos uses options.throttleMs=250 because mpv pushes time-pos at
  // decode rate (30-60 Hz); the trailing-throttle keeps IPC at the same
  // 250 ms cadence as today's poll.
  // Diagnostic-only time-pos subscriber for the mpv-launch-loop investigation.
  // Logs every time-pos value mpv pushes so we can detect retrograde jumps
  // (current_value < previous_value - 1) — the signature of an mpv-internal
  // segment-reset or a stray seek command. Independent of observePropertyEnabledRef
  // so we get the signal whether the Tier-4 push pipeline is on or off.
  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer) return;
    let lastValue: number | null = null;
    let lastLogAt = 0;
    const unsubscribe = mpvClient.observe(
      "time-pos",
      (value) => {
        const v = typeof value === "number" ? value : null;
        if (v === null) return;
        const now = Date.now();
        // Log every ~1s OR if we detect a retrograde jump >1s.
        const retrograde = lastValue !== null && v < lastValue - 1;
        if (retrograde) {
          mpvLog.warn({
            from: lastValue,
            to: v,
            jumpSec: (lastValue ?? 0) - v,
            lifecycleKind: lifecycleRef.current.kind,
          }, "time-pos RETROGRADE jump (segment reset or seek)");
        }
        if (now - lastLogAt > 1000 || retrograde) {
          const sample = { timePos: v, lifecycleKind: lifecycleRef.current.kind };
          // 1 Hz info while visible; debug while the window is hidden (issue
          // #25 P19-residual — no per-tick info logs from an invisible window).
          if (isAppWindowHidden()) mpvLog.debug(sample, "time-pos sample (hidden)");
          else mpvLog.info(sample, "time-pos sample");
          lastLogAt = now;
        }
        lastValue = v;
      },
      { throttleMs: 100 },
    );
    return () => {
      try { unsubscribe(); } catch { /* unsubscribe is best-effort */ }
    };
  }, [mpvClient, open, playerSession]);

  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer) return;
    if (!observePropertyEnabledRef.current) return;
    const unsubscribers: Array<() => void> = [];
    unsubscribers.push(
      mpvClient.observe(
        "time-pos",
        (value) => {
          observedTimePosRef.current = typeof value === "number" ? value : null;
        },
        { throttleMs: 250 },
      ),
    );
    unsubscribers.push(
      mpvClient.observe("duration", (value) => {
        observedDurationRef.current = typeof value === "number" ? value : null;
      }),
    );
    unsubscribers.push(
      mpvClient.observe("pause", (value) => {
        observedPauseRef.current = typeof value === "boolean" ? value : null;
        // eof-reached as last pushed (flag-gated path; the poll path reads both in one sample).
        noteMpvPause(value, observedEofRef.current);
      }),
    );
    unsubscribers.push(
      mpvClient.observe("mute", (value) => {
        observedMuteRef.current = typeof value === "boolean" ? value : null;
      }),
    );
    unsubscribers.push(
      mpvClient.observe("volume", (value) => {
        observedVolumeRef.current = typeof value === "number" ? value : null;
      }),
    );
    unsubscribers.push(
      mpvClient.observe("eof-reached", (value) => {
        observedEofRef.current = typeof value === "boolean" ? value : null;
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
      observedTimePosRef.current = null;
      observedDurationRef.current = null;
      observedPauseRef.current = null;
      observedMuteRef.current = null;
      observedVolumeRef.current = null;
      observedEofRef.current = null;
    };
  }, [mpvClient, open, playerSession]);

  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer) return;
    let cancelled = false;
    // Cooldown timestamp for the force-resume retry below — previously held
    // in a renderer-wide ref (`lastExternalResumeAttemptAtRef`) but it's
    // purely a poll-loop debounce, so scoping it to the poll effect's
    // closure is the simplest correct fix. Resets to 0 on every new effect
    // mount (e.g. new playerSession), which mirrors the prior ref-reset
    // behavior performed inside the lifecycle reset path.
    let lastResumeAttemptAt = 0;
    // Last pending start target whose suppressed pre-seek samples were logged
    // (log once per target, not every 250 ms).
    let loggedPendingTarget: number | null = null;
    // Last reason a progress save was skipped (log once per reason).
    let loggedSkippedSave: string | null = null;
    // Premature-EOF recoveries for this poll session (issue #25 P6).
    const prematureEof = new PrematureEofRecovery();
    // @bugfix @regression-proof issue #25 P19: while main reports the app
    // window hidden (mpv plays in its own window), the per-tick UI churn
    // (position, buffered bar, append %) is dropped and only the latest value
    // is applied on show. Re-rendering an invisible dialog 4×/s was ~30 % CPU
    // on the shared budget. The resume watchdog and the progress save keep
    // running; while hidden the whole poll drops to 1 Hz (P19-residual).
    const uiCurrentTime = createHiddenCoalescedSetter(setCurrentTime);
    const uiBufferedTime = createHiddenCoalescedSetter(setBufferedTime);
    const uiAppendProgress = createHiddenCoalescedSetter(setAppendProgress);
    let hiddenProgressSaves = 0;
    const unsubscribeVisibility = subscribeAppWindowVisibility((change) => {
      mpvLog.info({
        hidden: change.hidden,
        reason: change.reason,
        skippedTimeUpdates: uiCurrentTime.skipped(),
        skippedBufferedUpdates: uiBufferedTime.skipped(),
        skippedAppendUpdates: uiAppendProgress.skipped(),
        hiddenProgressSaves,
      }, change.hidden
        ? "poll: app window hidden — skipping UI-only state updates"
        : "poll: app window visible — applying latest UI state");
    });
    const poll = async () => {
      if (cancelled) return;
      try {
        // Tier-4 observe_property optimization: when the flag is on, read
        // the 6 push-friendly properties from the in-memory snapshot the
        // observe-subscription effect maintains. Cuts the IPC fan-out
        // from 8 properties to 2 (demuxer-cache-time, paused-for-cache).
        // When the flag is off, the poll path is identical to the pre-Tier-4
        // behavior.
        const usePushedSnapshot = observePropertyEnabledRef.current;
        const fetchPushed = <T,>(
          ref: { current: T | null },
          property:
            | "time-pos"
            | "duration"
            | "pause"
            | "mute"
            | "volume"
            | "eof-reached",
        ): Promise<T | null> => {
          if (usePushedSnapshot && ref.current !== null) {
            return Promise.resolve(ref.current);
          }
          return getProperty(sendExternalRequestRaw, property) as Promise<
            T | null
          >;
        };
        const [
          time,
          total,
          paused,
          muted,
          vol,
          cacheEnd,
          pausedForCache,
          eof,
        ] =
          await Promise.all([
            fetchPushed<number>(observedTimePosRef, "time-pos"),
            fetchPushed<number>(observedDurationRef, "duration"),
            fetchPushed<boolean>(observedPauseRef, "pause"),
            fetchPushed<boolean>(observedMuteRef, "mute"),
            fetchPushed<number>(observedVolumeRef, "volume"),
            getProperty(sendExternalRequestRaw, "demuxer-cache-time"),
            getProperty(sendExternalRequestRaw, "paused-for-cache"),
            fetchPushed<boolean>(observedEofRef, "eof-reached"),
          ]);
        // A tick that resolves after its effect was torn down (episode switch)
        // belongs to the previous target: apply nothing from it.
        if (cancelled) return;
        const allowUiUpdates = Date.now() >= manualStateUntilRef.current;
        // While a requested start has not landed, mpv reports its pre-seek
        // position (0). Trusting it overwrote the resume point and persisted
        // pct 0 (issue #25 P8, case c002) — keep the target until it lands.
        let timeTrusted = typeof time === "number";
        if (typeof time === "number") {
          const sampledAt = Date.now();
          // A premature-EOF recovery whose seek never showed up as landed
          // while mpv kept reporting EOF failed again: drop its target so
          // this sample counts as the next occurrence (issue #25 P6).
          if (prematureEof.recoveryStalled({ eof: eof ?? null, pendingTarget: pendingStart.get(), now: sampledAt })) {
            mpvLog.warn({ time, pendingStart: pendingStart.get() }, "poll: premature EOF recovery did not land — re-checking the EOF");
            pendingStart.arm(null);
          }
          const pendingTarget = pendingStart.get();
          const verdict = pendingStart.observe(time, sampledAt);
          if (verdict === "pending") {
            timeTrusted = false;
            if (loggedPendingTarget !== pendingTarget) {
              loggedPendingTarget = pendingTarget;
              mpvLog.info({ time, pendingStart: pendingTarget }, "poll: start target pending — ignoring pre-seek position (no UI/progress update)");
            }
          } else {
            if (verdict !== "none") {
              mpvLog.info({ time, pendingStart: pendingTarget, verdict }, verdict === "reached"
                ? "poll: start target reached"
                : "poll: start target abandoned — mpv kept playing elsewhere");
            }
            // @bugfix @regression-proof issue #25 P6: a premature EOF jumps
            // time-pos to the end. Do not trust it (no UI jump, no 100 %
            // save); seek back to the last trusted position instead.
            const eofVerdict = prematureEof.observe({
              eof: eof ?? null,
              time,
              duration: typeof total === "number" ? total : null,
              lastTrustedTime: lastKnownTimeRef.current,
              creditsStart: creditsStartRef.current,
              now: sampledAt,
            });
            if (eofVerdict.kind === "give-up") {
              mpvLog.warn({ time, ...eofVerdict }, "poll: premature EOF persists after recoveries — accepting the end");
            }
            if (eofVerdict.kind === "recover") {
              timeTrusted = false;
              mpvLog.warn({
                time,
                duration: total ?? null,
                ...eofVerdict,
                userPaused: userPausedRef.current,
              }, "poll: premature EOF (time-pos jumped to the end) — seeking back to the last trusted position");
              pendingStart.arm(eofVerdict.position);
              seekTargetRef.current = eofVerdict.position;
              void ensureExternalSeek(eofVerdict.position).then(() => {
                if (!cancelled && !userPausedRef.current) void resumeExternalPlayback({ auto: true });
              });
            } else {
              lastKnownTimeRef.current = time;
              uiCurrentTime.set(time);
            }
          }
        }
        const displayDuration =
          typeof total === "number" && Number.isFinite(total)
            ? Math.max(0, total)
            : null;
        const progressDuration = fallbackDuration > 0 ? fallbackDuration : displayDuration;
        if (displayDuration !== null) {
          setDuration(displayDuration);
        }
        if (typeof cacheEnd === "number") {
          uiBufferedTime.set(cacheEnd);
        } else if (typeof time === "number") {
          uiBufferedTime.set(time);
        }
        if (typeof muted === "boolean") {
          setIsMuted(muted);
        }
        if (typeof vol === "number") {
          setVolume(Math.min(1, Math.max(0, vol / 100)));
        }
        if (allowUiUpdates && typeof paused === "boolean") {
          setIsPlaying(!paused && !eof);
        }
        // @bugfix player-pause-resumes-by-itself: once mpv reports the value we
        // sent, a later pause is the user's and must not be "retried" away.
        noteMpvPause(paused, eof);
        lastSentPauseRef.current = markSentPauseSeen(lastSentPauseRef.current, paused);
        if (
          shouldForceResumeExternalPlayback({
            paused,
            pausedForCache,
            eof,
            userPaused: userPausedRef.current,
            blockAutoPlay: blockAutoPlayRef.current,
            externalActive: isExternalActive(lifecycleRef.current),
            now: Date.now(),
            lastAttemptAt: lastResumeAttemptAt,
            lastSentPause: lastSentPauseRef.current,
          })
        ) {
          lastResumeAttemptAt = Date.now();
          void resumeExternalPlayback({ auto: true });
        }
        if (allowUiUpdates) {
          if (typeof pausedForCache === "boolean") {
            setBufferingFromPoll(pausedForCache && !userPausedRef.current);
          } else if (typeof time !== "number" && !paused) {
            setBufferingFromPoll(true);
          } else {
            setBufferingFromPoll(false);
          }
        }
        if (progressDuration !== null && typeof cacheEnd === "number" && progressDuration > 0) {
          const pct = Math.min(100, Math.max(0, (cacheEnd / progressDuration) * 100));
          uiAppendProgress.set(Math.round(pct));
        }
        if (progressDuration !== null && typeof time === "number" && timeTrusted && progressDuration > 0) {
          // @bugfix @regression-proof issue #25 P2 (S2 x019): time-pos IS the
          // movie position; saving it minus an inferred offset lost the
          // scrub target when a scrub landed during the startup reload.
          const pct = (time / progressDuration) * 100;
          const now = Date.now();
          const last = lastProgressRef.current;
          const saveDecision = decidePolledProgressSave({
            pollTarget: { mediaId: media.id, episodeId: episodeId ?? null },
            liveTarget: progressTargetRef.current,
            loadInFlight: pendingStart.isLoadInFlight(),
          });
          if (!saveDecision.save) {
            if (loggedSkippedSave !== saveDecision.reason) {
              loggedSkippedSave = saveDecision.reason;
              playbackDebugLog.info({
                reason: saveDecision.reason,
                pct,
                episodeId,
                liveEpisodeId: progressTargetRef.current.episodeId,
                time,
              }, "progress poll save skipped — sample is not this target's playhead");
            }
          } else if (shouldPersistPlaybackProgress(last.at, now)) {
            loggedSkippedSave = null;
            lastProgressRef.current = { pct, at: now };
            // Per-save log: info while visible, debug while hidden (issue #25
            // P19-residual — no per-tick info logs from an invisible window).
            const saveFields = { pct, episodeId, time, progressDuration };
            if (isAppWindowHidden()) {
              hiddenProgressSaves += 1;
              playbackDebugLog.debug(saveFields, "progress poll save (hidden)");
            } else {
              playbackDebugLog.info(saveFields, "progress poll save");
            }
            // Phase 2: persist seconds alongside pct so the credits-aware
            // completion path can compare in absolute time.
            void setProgress(media.id, pct, episodeId ?? null, {
              positionSeconds: time,
              durationSeconds: progressDuration,
            });
          }
        }
      } catch (error) {
        mpvLog.warn({ error: String(error) }, "external poll failed");
      }
    };
    void poll();
    // 250 ms while visible, 1 Hz while hidden (issue #25 P19-residual). The
    // progress save rides the poll, so hidden saves land at most ~1 s apart.
    const pollInterval = createVisibilityAwareInterval(() => void poll(), { visibleMs: 250 });
    return () => {
      cancelled = true;
      pollInterval.dispose();
      unsubscribeVisibility();
      uiCurrentTime.dispose();
      uiBufferedTime.dispose();
      uiAppendProgress.dispose();
    };
  }, [ensureExternalSeek, episodeId, fallbackDuration, media.id, open, pendingStart, playerSession, resumeExternalPlayback, sendExternalRequestRaw, setProgress]);

  // ABR observation + decision loop (the shared `@space/playback-abr` controller, the same rules mobile runs).
  // Every 250 ms UI poll reads mpv's `demuxer-cache-state` (buffer, underrun); each decision tick (~1 Hz) also reads the
  // main-process link estimate (upstream segment throughput — mpv's own byte counters only gauge its cache, issue #25),
  // mpv's cache config and its decoder evidence (dropped frames, A/V desync, playback position, hwdec, codec). The decoder
  // half (`stepDecoder`: a device that cannot keep up moves to a lighter version, or says it is too weak, PLAY-CODEC-01..03)
  // runs first, then the network half (`stepNetworkAbr`). A switch goes through selectFixedFormat(..., "abr") — same path
  // as a manual OSC pick but the source flag prevents the user-target ref from being overwritten. There is no network rung
  // ban: Auto climbs back to the Settings quality when the network recovers (a decode ceiling stays for the file).
  useEffect(() => {
    if (!open || !mpvFlagsRef.current.externalPlayer) return;
    // Reset per-session ABR state on every new playerSession (new mpv launch or quality reload): the throughput history
    // and the anti-flap clocks restart, and the first upshift waits the cooldown (the link meter has no samples yet).
    // Codec blocks last until the file changes.
    abrPollCycleRef.current = 0;
    abrDecodeKeyRef.current = null;
    noteSessionStarted(abrCtrl, Date.now());
    let cacheConfig: CacheConfig = DESKTOP_DEFAULT_CACHE_CONFIG;
    let decisions = 0;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (!isExternalActive(lifecycleRef.current)) return;
      try {
        const data = await getProperty(sendExternalRequestRaw, "demuxer-cache-state");
        if (!data || typeof data !== "object") return;
        const bufferSecondsRaw =
          typeof data["cache-duration"] === "number" ? (data["cache-duration"] as number) : null;
        const pausedForCache = Boolean(data["underrun"]);
        const now = Date.now();


        // Visible: 250 ms ticks, decide every 4th (~1 Hz). Hidden: the tick
        // itself runs at 1 Hz, so every tick decides.
        abrPollCycleRef.current += 1;
        if (!isAppWindowHidden() && abrPollCycleRef.current % ABR_DECIDE_EVERY_N_POLLS !== 0) return;

        // No decision until the engine has signalled the launch is past its
        // ready-gate (otherwise we'd race the gate's 5s vo-configured budget).
        // PR 3.2e: `isReadyToReveal` is now `deriveIsReadyToReveal(phase)` at
        // the hook scope — the shadow-mode equivalence assertion is gone
        // (both sides are the same phase-derived value).
        if (!isReadyToReveal) return;

        // Read fresh values via refs — closure values were captured at effect
        // mount, but ABR runs on a long-lived interval and needs current state.
        const currentFmt = abrEffectiveFormatRef.current;
        if (!currentFmt) return;
        const liveFormats = abrFormatsRef.current;
        const variants = toVariants(liveFormats);
        // PLAY-QUAL-07 / STOR-BW-08: while the silo is saturated Auto may not go above its cap, and the playing rung steps
        // down to the best one under it at once, even when pinned (the silo holds the bytes to that rate anyway). No rung
        // under a free account's 480p cap: playback stops. A Starter / Standard 1080p cap never stops (capTarget).
        const cap = saturationRef.current.qualityCap;
        if (currentFmt.id === capRequestedRef.current) capRequestedRef.current = null;
        if (cap !== null && variants.length > 0) {
          const target = capTarget(variants, currentFmt.id, cap);
          if (target?.kind === "stop") {
            void window.sf?.reportPlaybackStopped?.();
            return;
          }
          if (target?.kind === "switch" && target.id !== capRequestedRef.current) {
            capRequestedRef.current = target.id;
            notify({
              title: t("player.abrToastTitle"),
              message: t(cap === "480p" ? "player.capToast480p" : "player.capToast1080p"),
              level: "info",
            });
            selectFixedFormatRef.current(target.id, "abr");
            return;
          }
        }
        if (variants.length < 2) return;
        const ladderInputs = abrLadderInputsRef.current;

        // The mpv cache the upshift gate derives from: re-read every ~10 s (cache-secs is shortened during a first-GOP
        // resume prefill and restored afterwards).
        if (decisions % 10 === 0) cacheConfig = await readMpvCacheConfig(sendExternalRequestRaw);
        decisions += 1;

        const [link, frameDrops, decoderDrops, timePos, paused, seeking, avsync, hwdec] = await Promise.all([
          window.sf?.getPlaybackLinkEstimate?.(),
          getProperty(sendExternalRequestRaw, "frame-drop-count"),
          getProperty(sendExternalRequestRaw, "decoder-frame-drop-count"),
          getProperty(sendExternalRequestRaw, "time-pos"),
          getProperty(sendExternalRequestRaw, "pause"),
          getProperty(sendExternalRequestRaw, "seeking"),
          getProperty(sendExternalRequestRaw, "avsync"),
          getProperty(sendExternalRequestRaw, "hwdec-current"),
        ]);
        // The link meter's own estimate (0 until its first sample): the controller adopts it as is (`netBpsIsSmoothed`).
        const netBps = link?.bps ?? 0;
        const bufferSeconds = bufferSecondsRaw ?? 0;

        // Sync the controller with what the engine is actually playing / allowed to do. A manual pick pins the rung
        // (issue #25 P19), as does Settings "Force this quality": `mode: "manual"` holds every automatic switch. The
        // ceiling is the Settings quality: a manual pick pins, so `userTargetQualityRef` can only differ while pinned.
        const pinned = forcePlaybackQualityRef.current || abrManualPinRef.current;
        abrCtrl.quality = { ...abrCtrl.quality, currentId: currentFmt.id, mode: pinned ? "manual" : "auto" };
        const settingsRank = qualityRank(abrPlaybackQualityRef.current);
        abrCtrl.settingsCeilingRank = cap === null ? settingsRank : capCeilingRank(settingsRank, cap);

        // A new load (format + reload stamp) restarts the lag window: mpv's drop counters start over with it.
        const decodeKey = `${currentFmt.id}@${abrCtrl.lastReloadAtMs ?? abrCtrl.loadStartedAtMs ?? "none"}`;
        if (decodeKey !== abrDecodeKeyRef.current) {
          abrDecodeKeyRef.current = decodeKey;
          resetLagDetector(abrCtrl.lag, now);
        }
        const droppedFrames =
          (typeof frameDrops === "number" ? frameDrops : 0) + (typeof decoderDrops === "number" ? decoderDrops : 0);
        // The codec of the playing version, as the library records it.
        const videoCodec = currentFmt.codec ?? null;
        const sample: AbrSample = {
          nowMs: now,
          sampledAtMs: now,
          voConfigured: true,
          pausedForCache,
          bufferSeconds,
          cacheReachedEof: data["eof"] === true,
          netBps,
          cache: cacheConfig,
          position: typeof timePos === "number" ? timePos : 0,
          paused: paused === true,
          seeking: seeking === true,
          droppedFrames,
          hwdec: typeof hwdec === "string" ? hwdec : null,
          videoCodec,
          avsyncSeconds: typeof avsync === "number" ? avsync : null,
          // The ladder keeps one row per quality, so the H.264 copy of the playing HEVC quality can sit behind it: hand the
          // decoder step the ladder rebuilt with the playing codec blocked (PLAY-CODEC-01 "HEVC to H.264 at the same size").
          decodeVariants:
            currentFmt.codec && needsH264Fallback(currentFmt.codec)
              ? toVariants(
                  buildPlaybackFormatsForFile(
                    ladderInputs.libraryFormats,
                    ladderInputs.fileId,
                    new Set([...ladderInputs.blockedCodecs, currentFmt.codec]),
                  ),
                )
              : undefined,
        };

        const action = stepDecoder(abrCtrl, variants, sample) ?? stepNetworkAbr(abrCtrl, variants, sample);
        const observedMbps = (abrCtrl.ewmaBps / 1_000_000).toFixed(1);

        const held = action.kind === "hold" ? (action.downshiftHeld ?? null) : null;
        if (held !== null && held !== abrHeldLoggedRef.current) {
          abrLog.info(
            {
              heldBy: held,
              current: currentFmt.quality,
              observedMbps,
              bufferSeconds: bufferSecondsRaw,
              sinceLoadStartMs: abrCtrl.loadStartedAtMs === null ? null : now - abrCtrl.loadStartedAtMs,
              sinceFirstFrameMs: abrCtrl.firstFrameAtMs === null ? null : now - abrCtrl.firstFrameAtMs,
              sinceReloadMs: abrCtrl.lastReloadAtMs === null ? null : now - abrCtrl.lastReloadAtMs,
            },
            "abr downshift held",
          );
        }
        abrHeldLoggedRef.current = held;
        if (action.kind === "warn") {
          // A pinned rung (Force / manual pick) the link cannot sustain: say so, never switch (PLAY-QUAL-03). The
          // controller rate-limits this to once a minute.
          const recommendedLabel = liveFormats.find((f) => f.id === action.recommendedId)?.quality ?? "?";
          abrLog.info(
            { current: currentFmt.quality, recommended: recommendedLabel, observedMbps, manualPin: abrManualPinRef.current },
            "abr force-quality insufficient",
          );
          notify({
            title: t("player.abrToastTitle"),
            message: t("player.abrInsufficient", {
              current: currentFmt.quality,
              recommended: recommendedLabel,
              mbps: observedMbps,
            }),
            level: "warning",
          });
          return;
        }
        if (action.kind === "too-weak") {
          // PLAY-CODEC-03 / PLAY-QUAL-03: nothing lighter is left (or the quality is pinned by Force or an in-player pick,
          // which a decoder fallback never overrides): say this computer cannot keep up, once per file. Playback goes on;
          // "Keep watching" only dismisses the notice.
          abrLog.info(
            {
              current: currentFmt.quality,
              codec: currentFmt.codec ?? null,
              verdict: action.verdict,
              pinned: action.pinned,
              manualPin: abrManualPinRef.current,
              droppedFrames,
              avsync: sample.avsyncSeconds,
              hwdec: sample.hwdec,
              bufferSeconds: bufferSecondsRaw,
            },
            "abr device-too-weak",
          );
          const message = t("player.deviceTooWeak.message");
          notify({
            title: t("player.abrToastTitle"),
            message: action.pinned ? `${message} ${t("player.deviceTooWeak.pinnedHint")}` : message,
            level: "warning",
            toastOptions: {
              duration: Infinity,
              action: {
                label: t("player.deviceTooWeak.keepWatching"),
                onClick: () => abrLog.info({ current: currentFmt.quality }, "abr device-too-weak keep-watching"),
              },
            },
          });
          return;
        }
        if (action.kind !== "switch") return;

        // Library rows: a decode fallback may target a row that only takes its quality slot once the codec block lands.
        const targetFormat = ladderInputs.libraryFormats.find((f) => f.id === action.targetId);
        const targetQualityLabel = targetFormat?.quality ?? "?";

        if (action.trigger === "decoder") {
          // PLAY-CODEC-01/02: this computer cannot keep up with the playing version; move to a lighter existing one for the
          // rest of the file. An HEVC -> H.264 move blocks the playing codec for the file, so the ladder slot shows the
          // H.264 row; a rung step is held by the controller's decode ceiling.
          const blockFileId = ladderInputs.fileId;
          const blockCodec = action.reason === "hevc-fallback" ? currentFmt.codec : null;
          if (blockCodec) {
            setAbrBlockedCodecs((prev) => ({
              fileId: blockFileId,
              codecs: new Set([...(prev.fileId === blockFileId ? prev.codecs : []), blockCodec]),
            }));
          }
          abrLog.info(
            {
              from: currentFmt.quality,
              fromCodec: currentFmt.codec ?? null,
              to: targetQualityLabel,
              toCodec: targetFormat?.codec ?? null,
              reason: action.reason,
              verdict: action.detail,
              blockedCodec: blockCodec,
              droppedFrames,
              avsync: sample.avsyncSeconds,
              hwdec: sample.hwdec,
              bufferSeconds: bufferSecondsRaw,
            },
            "abr decode-fallback",
          );
          notify({
            title: t("player.abrToastTitle"),
            message: t("player.abrDecodeFallback", { quality: targetQualityLabel }),
            level: "warning",
          });
          selectFixedFormatRef.current(action.targetId, "abr");
          return;
        }

        if (action.reason === "abr-downshift") {
          abrLog.info(
            {
              from: currentFmt.quality,
              to: targetQualityLabel,
              detail: action.detail,
              observedMbps,
              bufferSeconds: bufferSecondsRaw,
            },
            "abr downshift",
          );
          notify({
            title: t("player.abrToastTitle"),
            message: t("player.abrDownshift", {
              quality: targetQualityLabel,
              mbps: observedMbps,
            }),
            level: "warning",
          });
          selectFixedFormatRef.current(action.targetId, "abr");
          return;
        }

        abrLog.info(
          { from: currentFmt.quality, to: targetQualityLabel, observedMbps, bufferSeconds: bufferSecondsRaw },
          "abr upshift",
        );
        notify({
          title: t("player.abrToastTitle"),
          message: t("player.abrUpshift", { quality: targetQualityLabel }),
          level: "info",
        });
        selectFixedFormatRef.current(action.targetId, "abr");
      } catch (err) {
        abrLog.warn({ err: String(err) }, "abr tick failed");
      }
    };

    void tick();
    // 250 ms while visible, 1 Hz while hidden (issue #25 P19-residual).
    const tickInterval = createVisibilityAwareInterval(() => void tick(), { visibleMs: 250 });
    return () => {
      cancelled = true;
      tickInterval.dispose();
    };
    // selectFixedFormat / formats / effectiveFormat / playbackQuality are
    // intentionally excluded from the deps to keep the interval stable across
    // UI updates; the closure reads them via refs (mirrored above) so each
    // tick observes the current value.
  }, [abrCtrl, open, playerSession, sendExternalRequestRaw, isReadyToReveal, t]);

  // mpv's first playback-restart of each file is the ABR clock's first frame.
  // A resume shows nothing until its seek-target segment is in, however long
  // that takes on the link. @bugfix @regression-proof issue #25 N4
  useEffect(() => {
    if (!open) return;
    return window.sf?.onMpvExternalMessage?.((msg) => {
      if (msg.type !== "playback_restart") return;
      noteFirstFrame(abrCtrl, Date.now());
      const { loadStartedAtMs } = abrCtrl;
      abrLog.info(
        { sinceLoadStartMs: loadStartedAtMs === null ? null : Date.now() - loadStartedAtMs },
        "abr clock: first frame of the load (mpv playback-restart)",
      );
    });
  }, [abrCtrl, open]);

  const togglePlay = async () => {
    if (isBuffering) return;
    const next = !isPlaying;
    userPausedRef.current = !next;
    if (next) notePlayRequest();
    else noteUserPause();
    holdManualState(400);
    await sendPauseCommand(!next);
    setIsPlaying(next);
  };

  const toggleMute = () => {
    void sendExternalCommand(buildSetPropertyCommand("mute", !isMuted));
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    void sendExternalCommand(buildSetPropertyCommand("volume", Math.round(clamped * 100)));
    if (isMuted && clamped > 0) {
      void sendExternalCommand(buildSetPropertyCommand("mute", false));
      setIsMuted(false);
    }
    setVolume(clamped);
  };

  const requestSeek = (targetTime: number, wasPlaying?: boolean) => {
    const resumePlaying = wasPlaying ?? isPlaying;
    // @bugfix @regression-proof app-seek-dropped-before-duration-poll: the
    // polled duration lags mpv (1 Hz while the app window is hidden), so a
    // seek in a file's first second read 0 and was dropped. mpv's own
    // duration stands in until the poll lands.
    void resolveSeekDuration(safeDuration || duration, () => getProperty(sendExternalRequest, "duration")).then((durationValue) => {
      if (durationValue === null) {
        mpvLog.warn({ targetTime, phaseKind: phaseRef.current.kind }, "requestSeek: mpv reports no duration — seek dropped");
        return;
      }
      applyRequestedSeek(targetTime, durationValue, resumePlaying);
    });
  };

  const applyRequestedSeek = (targetTime: number, durationValue: number, resumePlaying: boolean) => {
    const clamped = Math.min(durationValue, Math.max(0, targetTime));
    seekTargetRef.current = clamped;
    // The refill stall after a seek is the seek, not the network: hold ABR downshifts for it.
    noteSeek(abrCtrl, Date.now());
    // The seek target is the trusted position from now on: an app seek
    // straight to the end must not read as a premature EOF and be seeked
    // back (issue #25 P6), same as the OSC seek handler.
    lastKnownTimeRef.current = clamped;
    // A seek during a reload is carried through it (issue #25 P1b).
    pendingStart.userSeek(clamped);
    autoPlayRef.current = resumePlaying;
    holdManualState(500);
    if (isExternalZeroSeek(clamped)) {
      setCurrentTime(0);
      void startFrom(0, autoPlayRef.current);
      return;
    }
    void ensureExternalSeek(clamped);
    if (autoPlayRef.current) {
      void sendPauseCommand(false);
    }
    setCurrentTime(clamped);
  };

  // @bugfix @regression-proof issue #25 c035 / c065 / s1:x002: the switch
  // is recorded in `formatSwitch`, and the init effect completes it on
  // every path. The resume point recorded here comes from the pending start
  // target or the polled `lastKnownTimeRef`, never the render-closure
  // `currentTime`; the reload re-reads mpv's live time-pos anyway.
  const selectFixedFormat = (formatId: string, source: "user" | "abr" = "user") => {
    setBufferingImmediate(true);
    setIsPlaying(false);
    void setPaused(true);
    autoPlayRef.current = !userPausedRef.current;
    const resumeTime = resolveFormatSwitchResumeTime({
      pendingStart: pendingStart.get(),
      lastKnownTime: lastKnownTimeRef.current,
    });
    const request = formatSwitch.request({
      source,
      formatId,
      now: Date.now(),
      resumeAutoplay: autoPlayRef.current,
    });
    mpvLog.info({
      formatId,
      source,
      switchId: request.id,
      resumeTime,
      pendingStart: pendingStart.get(),
      uiTime: currentTime,
      resumeAutoplay: request.resumeAutoplay,
      phaseKind: phaseRef.current.kind,
    }, "selectFixedFormat: resume point");
    lastKnownTimeRef.current = resumeTime;
    seekTargetRef.current = resumeTime;
    // Re-fire the init effect even when the format signature does not
    // change (picking the current format, or a switch back before the
    // previous one landed): it then settles the switch and resumes mpv
    // instead of leaving it paused.
    setFormatSwitchRetryNonce((value) => value + 1);
    // ABR-driven switches preserve the user's previously-stated quality
    // preference (target ceiling). Only an intentional pick (app menu or OSC
    // video menu) rewrites it — and pins the rung, so ABR stops switching
    // until the user picks Auto again (issue #25 P19).
    if (source === "user") {
      abrManualPinRef.current = true;
      const fmt = formats.find((f) => f.id === formatId);
      if (fmt && isQualityPreset(fmt.quality)) {
        userTargetQualityRef.current = fmt.quality;
      }
    }
    setQualityMode("fixed");
    setSelectedFormatId(formatId);
  };

  const selectAutoQuality = () => {
    setBufferingImmediate(true);
    setIsPlaying(false);
    void setPaused(true);
    autoPlayRef.current = !userPausedRef.current;
    const resumeTime = resolveFormatSwitchResumeTime({
      pendingStart: pendingStart.get(),
      lastKnownTime: lastKnownTimeRef.current,
    });
    const request = formatSwitch.request({
      source: "auto",
      formatId: null,
      now: Date.now(),
      resumeAutoplay: autoPlayRef.current,
    });
    mpvLog.info({
      switchId: request.id,
      resumeTime,
      pendingStart: pendingStart.get(),
      uiTime: currentTime,
      resumeAutoplay: request.resumeAutoplay,
      phaseKind: phaseRef.current.kind,
    }, "selectAutoQuality: resume point");
    lastKnownTimeRef.current = resumeTime;
    seekTargetRef.current = resumeTime;
    // "auto" may resolve to the format already playing: re-fire the init
    // effect so the switch settles (and mpv resumes) either way.
    setFormatSwitchRetryNonce((value) => value + 1);
    // Auto means "let ABR pick within the settings preference" — clear any
    // session-scoped user override so the target falls back to playbackQuality.
    userTargetQualityRef.current = null;
    abrManualPinRef.current = false;
    setQualityMode("auto");
  };

  // Now that selectFixedFormat is in scope, wire the indirection ref the ABR
  // poll loop reads. Writing to a ref during render is OK (refs are React's
  // explicit escape hatch from the purity rules).
  selectFixedFormatRef.current = selectFixedFormat;
  // Same pattern for formats / effectiveFormat / playbackQuality — the ABR
  // poll loop runs on a long-lived setInterval and reads these every tick
  // through refs, so changes don't have to restart the timer.
  const abrFormatsRef = useRef(formats);
  abrFormatsRef.current = formats;
  const abrEffectiveFormatRef = useRef(effectiveFormat);
  abrEffectiveFormatRef.current = effectiveFormat;
  const abrPlaybackQualityRef = useRef(playbackQuality);
  abrPlaybackQualityRef.current = playbackQuality;

  // @bugfix @regression-proof start-from-dead-mpv-dropped (#2776)
  // A start (Resume, Start over) that arrives after mpv quit but before the
  // exit event reached the lifecycle takes the alive-mpv seek path against a
  // dead socket. When the seek reports the player gone, relaunch at the start
  // position instead of dropping the user's request. `startGenRef` lets a
  // newer start, or the player closing, cancel a pending relaunch.
  const startGenRef = useRef(0);
  useEffect(() => () => {
    startGenRef.current += 1;
  }, [open]);
  const seekStartOrRelaunch = useCallback(async (time: number, autoplay: boolean) => {
    const gen = startGenRef.current;
    const outcome = await ensureExternalSeek(time);
    if (outcome !== "player-gone") return;
    if (startGenRef.current !== gen) {
      mpvLog.info({ time, outcome }, "startFrom: mpv gone, but a newer start or a close superseded this one — no relaunch");
      return;
    }
    mpvLog.info({ time, autoplay, lifecycleKind: lifecycleRef.current.kind }, "startFrom: mpv exited under the start → relaunching at the start position");
    dispatchPhase({ type: "set_intent_pending", intent: "userManual" });
    dispatchPhase({ type: "start_load", intent: "userManual" });
    await runReportingLoadFailure(async () => {
      await loadStream({ startTime: time > ZERO_SEEK_EPS ? time : null, paused: !autoplay });
    }, (error) => reportLoadFailure(error, "start-relaunch"));
  }, [dispatchPhase, ensureExternalSeek, loadStream, reportLoadFailure]);

  const startFrom = useCallback((time: number, autoplay: boolean) => {
    mpvLog.info({
      time,
      autoplay,
      lifecycleKind: lifecycleRef.current.kind,
      processActive: isExternalActive(lifecycleRef.current),
    }, "startFrom: enter");
    seekTargetRef.current = time;
    startGenRef.current += 1;
    pendingStart.arm(time);
    lastKnownTimeRef.current = time;
    autoPlayRef.current = autoplay;
    holdManualState(600);
    if (time <= ZERO_SEEK_EPS && isExternalActive(lifecycleRef.current)) {
      mpvLog.info({ time }, "startFrom: zero-seek on alive mpv → seek to 0 (relaunch if mpv is gone) + unpause");
      void seekStartOrRelaunch(0, autoplay);
      void sendPauseCommand(!autoplay);
      setCurrentTime(0);
      return;
    }
    if (isExternalZeroSeek(time)) {
      mpvLog.info({ time }, "startFrom: zero-seek path → pauseForChange + loadStream");
      // PR 3.2b-flip + 3.2c-2: park the intent on phase, then dispatch
      // start_load directly (this is the second producer of start_load
      // alongside the init-effect top — the init effect path doesn't
      // cover startFrom's direct-loadStream call). The init effect's
      // post-launch consume guard reads `phase.lastConsumedIntent` to
      // decide whether to short-circuit its own loadStream call; consume_intent
      // (init guard) or process_gone (mpv died) clears it.
      dispatchPhase({ type: "set_intent_pending", intent: "userZeroSeek" });
      dispatchPhase({ type: "start_load", intent: "userZeroSeek" });
      void pauseForChange(() => runReportingLoadFailure(async () => {
        await loadStream({ startTime: null, paused: !autoplay });
      }, (error) => reportLoadFailure(error, "start-over")));
      return;
    }
    // Only fire seek/unpause against a LIVE mpv. If mpv hasn't launched
    // yet (the Resume-prompt path: user clicked Play → resume prompt
    // appeared with deferPlayback=true so the init effect short-circuited
    // and mpv never started → user clicks Resume → startFrom runs here
    // BEFORE the init effect re-fires to actually launch mpv), the
    // void'd ensureExternalSeek would run its 6-attempt retry loop with
    // 200ms gaps for ~1.2s. mpv launches with --start=<resumeTime> and
    // paused=true, so it would already be at the right position. Each
    // attempt that lands AFTER mpv socket is alive sends a redundant
    // seek-absolute-exact command — and mpv responds by re-seeking,
    // aborting in-progress decode each time. The user-observed 3-10 s
    // segment loop on Resume is exactly this: a single mpv launch, but
    // 4-6 seek commands hammering it during the first second of decode,
    // making it restart the segment over and over.
    //
    // The init effect's launch branch (loadStream:1296-1314) already
    // handles the resume-time correctness with the --start cmdline plus
    // a verify-pass ensureExternalSeek that only fires if time-pos
    // diverges by more than 2 s. So the renderer-side eager seek here
    // is pure redundancy.
    //
    // seekTargetRef.current is already set to `time` above, so the init
    // effect's `resumeTime = seekTargetRef.current` read picks it up and
    // launches mpv at the correct position. autoPlayRef is also set
    // so shouldAutoPlay will pick the right value.
    //
    // @bugfix mpv-launch-loop-startfrom-seeks-dead-mpv
    if (!isExternalActive(lifecycleRef.current)) {
      mpvLog.info({
        time,
        autoplay,
        lifecycleKind: lifecycleRef.current.kind,
      }, "startFrom: non-zero path, mpv not alive — defer to init effect launch (no seek/unpause)");
      return;
    }
    mpvLog.info({
      time,
      autoplay,
      lifecycleKind: lifecycleRef.current.kind,
    }, "startFrom: non-zero path on alive mpv → seek (relaunch if mpv is gone) + sendPauseCommand");
    void seekStartOrRelaunch(time, autoplay);
    void sendPauseCommand(!autoplay);
  }, [
    seekStartOrRelaunch,
    holdManualState,
    isExternalZeroSeek,
    loadStream,
    pauseForChange,
    reportLoadFailure,
    dispatchPhase,
    sendPauseCommand,
    pendingStart,
  ]);

  const prepareEpisodeStart = useCallback((time: number, autoplay: boolean) => {
    seekTargetRef.current = time;
    // A live mpv still plays the previous episode until the switch's
    // loadfile lands: its samples are not this episode's progress (issue #25
    // NEW-resume-wrong-episode). loadStream re-arms and releases the gate.
    if (isExternalActive(lifecycleRef.current)) pendingStart.armForReload(time);
    else pendingStart.arm(time);
    lastKnownTimeRef.current = time;
    autoPlayRef.current = autoplay;
    userPausedRef.current = !autoplay;
    if (autoplay) notePlayRequest();
  }, [pendingStart]);

  const clearResumeTarget = useCallback(() => {
    seekTargetRef.current = null;
  }, []);

  // Memoize so consumers (e.g. MediaPlaybackController's requestId-keyed
  // reset effect at MediaPlaybackController.tsx:372) can rely on a stable
  // reference across renders. Without this, every render of the engine
  // produced a new function identity, churning the reset effect's deps
  // array and re-firing the effect on every commit — observed at 405
  // fires in ~10 s during one Play click. Functionally harmless (the
  // setSelectedAudioId no-op when the value is unchanged) but extremely
  // noisy in logs and a CPU drag.
  //
  // Param widened to `string | null` to match the underlying useState's
  // type so the reset effect can pass `null` (the "no selection" sentinel
  // the audio resolver effect interprets as "fall through to default")
  // without a TS narrowing violation.
  // @bugfix mpv-launch-loop-from-controller-mount-storm
  const setSelectedAudio = useCallback((trackId: string | null) => {
    setSelectedAudioId(trackId);
  }, []);
  const setSelectedSubtitle = useCallback((trackId: string) => {
    // The app's own subtitle choice wins over an earlier raw OSC sid (P18).
    oscTrackPicksRef.current.clearSubtitle();
    setSubtitlesOffPicked(trackId === "off");
    setSelectedSubtitleId(trackId);
  }, []);
  // The controller's per-request reset to the media's default ("off" when it has
  // none yet): not a user choice, so it must not pin Off against a default track
  // that arrives with the refreshed media (@bugfix #25 Orchard, subtitlesOffPicked).
  const resetSelectedSubtitle = useCallback((trackId: string) => {
    oscTrackPicksRef.current.clearSubtitle();
    setSubtitlesOffPicked(false);
    setSelectedSubtitleId(trackId);
  }, []);
  // PLAY-SUBGET-02, -23: the subtitle just stored from the mpv menu (fetched or added from a file) is the pick once the
  // media lists it; the apply effect then sub-adds it with mpv's "select" flag while playback resumes.
  useEffect(() => {
    const fetched = fetchedSubtitleRef.current;
    if (!fetched) return;
    const track = media.subtitleTracks.find(
      (item) =>
        (item.episodeId ?? null) === fetched.episodeId &&
        item.language === fetched.language &&
        item.label === fetched.label &&
        isRemovableSubtitleSource(item.source) &&
        item.id !== fetched.replacedId
    );
    if (!track) return;
    fetchedSubtitleRef.current = null;
    mpvSubtitleLog.info({ trackId: track.id, label: track.label }, "fetched subtitle listed: switching it on");
    setSelectedSubtitle(track.id);
  }, [fetchedSubtitleTick, media.subtitleTracks, setSelectedSubtitle]);

  useEffect(() => {
    if (!open) return;
    if (!effectiveFormatMap || !effectiveFormatId || effectiveFormatChunkKeys.length === 0) return;
    const nextKeys = effectiveFormatMap.chunks.map((chunk) => chunk.key);
    if (effectiveFormatChunkKeys.length !== nextKeys.length || effectiveFormatChunkKeys[0] !== nextKeys[0]) {
      void setMediaFormatChunks(effectiveFormatId, nextKeys);
    }
  }, [open, effectiveFormatMap, effectiveFormatId, effectiveFormatChunkKeys, setMediaFormatChunks]);

  return {
    engine: "mpv",
    playerType: "canvas",
    playerRef,
    setPlayerNode,
    file,
    formats,
    formatSupport,
    qualityMode,
    selectedFormatId,
    selectedFormat,
    autoFormat,
    effectiveFormat,
    streamError,
    isBuffering,
    isPlaying,
    isReadyToReveal,
    appendProgress,
    currentTime,
    duration,
    bufferedTime,
    isMuted,
    volume,
    togglePlay,
    toggleMute,
    handleVolumeChange,
    requestSeek,
    selectFixedFormat,
    selectAutoQuality,
    startFrom,
    flushProgress,
    prepareEpisodeStart,
    clearResumeTarget,
    safeDuration,
    subtitleOptions,
    selectedSubtitleId,
    setSelectedSubtitleId: setSelectedSubtitle,
    resetSelectedSubtitleId: resetSelectedSubtitle,
    subtitleUrl: null,
    activeSubtitle: null,
    activeSubtitleImage: null,
    pgsTimeOffset,
    setPgsTimeOffset,
    audioOptions,
    selectedAudioId,
    setSelectedAudioId: setSelectedAudio,
    chapters,
  };
};
