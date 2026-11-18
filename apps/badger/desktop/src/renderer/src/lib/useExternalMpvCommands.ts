/**
 * External mpv command facade.
 *
 * Phase 4.1 of the playback-engine hardening
 * plan. Owns the
 * mpv IPC seam — all 12 helpers that loadStream used to declare inline.
 *
 * Surface area:
 *   Raw + ready primitives (4.1a):
 *     - `sendExternalCommandRaw` — fire-and-forget command (no gate)
 *     - `sendExternalRequestRaw` — request/response (no gate)
 *     - `ensureExternalReady`    — gate the lifecycle/socket readiness
 *   Gated send/request (4.1b):
 *     - `sendExternalCommand`           — gated fire-and-forget
 *     - `sendExternalRequest`           — gated request/response
 *     - `sendExternalCommandUnchecked`  — no-ready-gate command with rich error logging
 *   Wait family (4.1b):
 *     - `waitForExternalTracksStable`   — poll track-list until stable
 *     - `waitForVoConfigured`           — wait for first frame on screen
 *     - `waitForMetadataApplied`        — wait for sf.lua to apply subs/chapters
 *     - `waitForExternalPause`          — wait for pause-state to match expected
 *   Probe (4.1b):
 *     - `confirmExternalPlaybackReady`  — verify post-launch decoding
 *   Phase-coupled seek (4.1c):
 *     - `ensureExternalSeek` — phase-gated seek with retry loop
 *
 * `ensureExternalSeek` reads `phase` at CALL time via a ref. Seek targets
 * are movie time and go to mpv unchanged: mpv's `time-pos` is movie time
 * for our 0-based VOD streams (issue #25 P2 removed the timeline offset).
 *
 * The hook is intentionally a hook (not a plain factory function)
 * because it needs `useCallback` to preserve stable callback identities
 * for the engine's downstream dep arrays.
 */

import { useCallback, useRef } from "react";
import type { MutableRefObject } from "react";

import { seeksAllowed, type PlaybackPhase } from "@space/desktop-mpv-playback";
import {
  buildGetPropertyCommand,
  buildSeekCommand,
  buildTrackSignature,
  getProperty,
  hasUsableExternalTrackState,
  isExternalMpvResponseError,
  pollMetadataApplied,
  pollVoConfigured,
  type LifecycleState,
  type MpvClient,
  type MpvCommand,
  type MpvResponse,
} from "@space/mpv-protocol";

import type { UncheckedSendOutcome } from "@/lib/mpvMetadataBackoff";
import { hasLiveExternalPlayer, isExternalActive, isExternalReady } from "@/lib/mpvPlaybackState";
import { rendererLogger } from "@/logger";

const mpvLog = rendererLogger.child({ scope: "mpv" });
const subPipelineLog = rendererLogger.child({ scope: "sub-pipeline" });

export type ExternalMpvCommandsParams = {
  /** Shared mpv client (preloadMpvClient singleton). */
  mpvClient: MpvClient;
  /** Engine-owned ref for mpv mode flags (externalPlayer / smokeTest). */
  mpvFlagsRef: MutableRefObject<{ smokeTest: boolean; externalPlayer: boolean }>;
  /** Engine-owned ref mirroring the lifecycle store snapshot. */
  lifecycleRef: MutableRefObject<LifecycleState>;
  /**
   * Engine-owned ref mirroring the playback-phase store snapshot.
   * Used by `ensureExternalSeek`'s `seeksAllowed(phase)` gate (PR 3.2d).
   */
  phaseRef: MutableRefObject<PlaybackPhase>;
  /** Engine-owned ref for the last-known mpv time. Written by ensureExternalSeek. */
  lastKnownTimeRef: MutableRefObject<number>;
};

export type ExternalMpvCommands = {
  /** Raw fire-and-forget command (no ready gate, no lifecycle gate). */
  sendExternalCommandRaw: (command: MpvCommand) => Promise<MpvResponse | null>;
  /** Raw request/response (no ready gate, no lifecycle gate). */
  sendExternalRequestRaw: (command: MpvCommand) => Promise<MpvResponse | null>;
  /**
   * Resolves when mpv's IPC socket is up AND it has responded to a
   * `get_property time-pos` probe. Returns `false` if the external
   * player is disabled or mpv is idle/stopping. Idempotent — concurrent
   * callers share the in-flight `mpvClient.waitForReady` promise.
   */
  ensureExternalReady: () => Promise<boolean>;
  /**
   * Gated fire-and-forget. Returns `true` if mpv accepted (or replied
   * with `error: "success"`); `false` on any IPC failure / mpv error
   * response. Bails immediately if externalPlayer is disabled or mpv
   * is idle/stopping.
   */
  sendExternalCommand: (command: MpvCommand) => Promise<boolean>;
  /**
   * Gated command that returns mpv's raw reply (`null` when externalPlayer
   * is disabled, mpv is idle/stopping or the ready gate fails; IPC errors
   * reject). For callers that must tell an error reply from a transport
   * timeout, e.g. the backdrop handoff's `loadfile` (issue #25 P17).
   */
  sendExternalCommandReply: (command: MpvCommand) => Promise<MpvResponse | null>;
  /**
   * Gated request/response. Returns the mpv response object on success,
   * or `null` if externalPlayer is disabled, mpv is idle/stopping, the
   * ready gate fails, or the IPC throws.
   */
  sendExternalRequest: (command: MpvCommand) => Promise<MpvResponse | null>;
  /**
   * No-ready-gate command (bypasses `ensureExternalReady`) with rich
   * error logging. Used for setting `pause` immediately and other
   * fire-and-forget paths where the ready gate would add unnecessary
   * latency or block. Resolves "socket-missing" when main answered
   * `mpv_socket_missing` (the targeted mpv is gone), so a batch can tell a
   * torn-down mpv from a real command error.
   */
  sendExternalCommandUnchecked: (command: MpvCommand) => Promise<UncheckedSendOutcome>;
  /**
   * Polls mpv's track-list + time-pos until both signal a stable
   * decoded state (or returns false after 15s). The "stable" predicate
   * lives in `hasUsableExternalTrackState`.
   */
  waitForExternalTracksStable: () => Promise<boolean>;
  /**
   * Waits for mpv's video-output to be configured (first frame visible).
   * The gate that drives signalPlaybackReady → window-hide. Caps at
   * `budgetMs`; returns false on timeout.
   */
  waitForVoConfigured: (budgetMs: number) => Promise<boolean>;
  /**
   * Waits for sf.lua to apply the expected number of subtitles +
   * chapters. Best-effort; not load-bearing for window-hide.
   */
  waitForMetadataApplied: (
    expected: { expectedExternalSubtitles?: number; expectedChapters?: number },
    budgetMs: number,
  ) => Promise<boolean>;
  /**
   * Polls mpv's `pause` property until it matches `expected`. Up to
   * 20 attempts × 150ms = 3s ceiling. Tolerant of transient IPC errors.
   */
  waitForExternalPause: (expected: boolean) => Promise<boolean>;
  /**
   * Post-launch probe: verify mpv is actively decoding by checking the
   * track-list is non-empty AND time-pos is a valid number ≥ 0. Up to
   * 8 attempts × 250ms = 2s ceiling.
   */
  confirmExternalPlaybackReady: () => Promise<boolean>;
  /**
   * Phase-gated absolute seek. Bails if `seeksAllowed(phaseRef.current)`
   * is false (the deliberate locked split — covers backdrop-handoff
   * window + reload pre-load-done window). Otherwise issues up to 6
   * `seek absolute exact` commands until mpv reports a time-pos within
   * 0.5s of `target`.
   *
   * Resolves how the seek ended. `"player-gone"`: mpv exited under it
   * (the lifecycle left the active states during the retries, or within
   * `PLAYER_GONE_GRACE_MS` after a run where mpv never answered) — the
   * caller decides whether the request needs a relaunch (#2776).
   *
   * @bugfix @regression-proof seek-gate-phase-flip (PR 3.2d)
   * @bugfix @regression-proof start-from-dead-mpv-dropped (#2776)
   */
  ensureExternalSeek: (target: number) => Promise<ExternalSeekOutcome>;
};

export type ExternalSeekOutcome = "invalid" | "blocked" | "settled" | "exhausted" | "player-gone";

/**
 * After a seek run in which mpv never answered, how long to wait for the
 * lifecycle to report the exit. The socket dies first; the renderer's
 * lifecycle follows 100–600 ms later under load (movie-playback e2e,
 * 2026-11-16).
 */
const PLAYER_GONE_GRACE_MS = 2_000;

export const useExternalMpvCommands = (
  params: ExternalMpvCommandsParams,
): ExternalMpvCommands => {
  const {
    mpvClient,
    mpvFlagsRef,
    lifecycleRef,
    phaseRef,
    lastKnownTimeRef,
  } = params;

  // Facade-local seek ID counter. Used in log lines so callers can
  // correlate enter/attempt/settled/exhausted messages across the
  // helper's async flow.
  const ensureExternalSeekIdRef = useRef(0);

  const sendExternalCommandRaw = useCallback(
    async (command: MpvCommand) => {
      if (!mpvFlagsRef.current.externalPlayer) {
        return null;
      }
      // No active-state gate here — raw functions let the main-process
      // socket layer handle dead-process detection. The lifecycle
      // snapshot can lag a re-render or React-19 strict-mode double-
      // effect; the main process is the authoritative source.
      return await mpvClient.command(command);
    },
    [mpvClient, mpvFlagsRef],
  );

  const sendExternalRequestRaw = useCallback(
    async (command: MpvCommand) => {
      if (!mpvFlagsRef.current.externalPlayer) {
        return null;
      }
      return await mpvClient.request(command);
    },
    [mpvClient, mpvFlagsRef],
  );

  const ensureExternalReady = useCallback(async () => {
    if (
      !mpvFlagsRef.current.externalPlayer ||
      !isExternalActive(lifecycleRef.current)
    ) {
      return false;
    }
    if (isExternalReady(lifecycleRef.current)) return true;
    // mpvClient.waitForReady consolidates the 12-attempt time-pos retry
    // that used to live here. It is idempotent — concurrent callers
    // share the same in-flight promise — so we no longer need a
    // renderer-local ready promise ref to deduplicate.
    return await mpvClient.waitForReady(15000);
  }, [lifecycleRef, mpvClient, mpvFlagsRef]);

  const waitForExternalTracksStable = useCallback(async () => {
    if (
      !mpvFlagsRef.current.externalPlayer ||
      !isExternalActive(lifecycleRef.current)
    ) {
      return false;
    }
    const ready = await ensureExternalReady();
    if (!ready) return false;
    const maxWaitMs = 15000;
    const pollMs = 250;
    let lastSignature = "";
    let lastChangeAt = Date.now();
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
      const [result, timeRes] = await Promise.all([
        sendExternalRequestRaw(buildGetPropertyCommand("track-list")),
        sendExternalRequestRaw(buildGetPropertyCommand("time-pos")),
      ]);
      const list = Array.isArray(result?.data) ? result.data : [];
      const signature = buildTrackSignature(list);
      if (signature !== lastSignature) {
        lastSignature = signature;
        lastChangeAt = Date.now();
      }
      const timePos = typeof timeRes?.data === "number" ? timeRes.data : null;
      if (hasUsableExternalTrackState(list, timePos, Date.now() - lastChangeAt)) {
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, pollMs));
    }
    return false;
  }, [ensureExternalReady, lifecycleRef, mpvFlagsRef, sendExternalRequestRaw]);

  const waitForMetadataApplied = useCallback(
    async (
      expected: { expectedExternalSubtitles?: number; expectedChapters?: number },
      budgetMs: number,
    ) => {
      const externalPlayer = mpvFlagsRef.current.externalPlayer;
      const lifecycleKind = lifecycleRef.current.kind;
      const active = isExternalActive(lifecycleRef.current);
      if (!externalPlayer || !active) {
        mpvLog.info(
          { lifecycleKind, externalPlayer, active },
          "waitForMetadataApplied: bail (not active)",
        );
        return false;
      }
      const wantAnything =
        (expected.expectedExternalSubtitles ?? 0) > 0 ||
        (expected.expectedChapters ?? 0) > 0;
      if (!wantAnything) return true;
      const ready = await ensureExternalReady();
      if (!ready) return false;
      return pollMetadataApplied(expected, budgetMs, sendExternalRequestRaw);
    },
    [ensureExternalReady, lifecycleRef, mpvFlagsRef, sendExternalRequestRaw],
  );

  const waitForVoConfigured = useCallback(
    async (budgetMs: number) => {
      const externalPlayer = mpvFlagsRef.current.externalPlayer;
      const lifecycleKind = lifecycleRef.current.kind;
      const active = isExternalActive(lifecycleRef.current);
      if (!externalPlayer || !active) {
        mpvLog.info(
          { lifecycleKind, externalPlayer, active },
          "waitForVoConfigured: bail (not active)",
        );
        return false;
      }
      const ready = await ensureExternalReady();
      if (!ready) return false;
      return pollVoConfigured(budgetMs, sendExternalRequestRaw);
    },
    [ensureExternalReady, lifecycleRef, mpvFlagsRef, sendExternalRequestRaw],
  );

  const sendExternalCommandReply = useCallback(
    async (command: MpvCommand) => {
      if (
        !mpvFlagsRef.current.externalPlayer ||
        !isExternalActive(lifecycleRef.current)
      ) {
        return null;
      }
      const ready = await ensureExternalReady();
      if (!ready) return null;
      return await sendExternalCommandRaw(command);
    },
    [ensureExternalReady, lifecycleRef, mpvFlagsRef, sendExternalCommandRaw],
  );

  const sendExternalCommand = useCallback(
    async (command: MpvCommand) => {
      try {
        const result = await sendExternalCommandReply(command);
        // mpv IPC always replies with `error: "success"` on OK — only
        // treat non-"success" error values as real failures. A naive
        // `"error" in result` check treats EVERY successful mpv response
        // as failure and silently drops fire-and-forget commands.
        // mpv_socket_missing recovery is no longer the renderer's
        // concern — the main-process UnixSocketMpvClient dispatches
        // process_exited / socket_failed events to the reducer, which
        // transitions the lifecycle out of "ready" automatically.
        if (result === null || isExternalMpvResponseError(result)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    [sendExternalCommandReply],
  );

  const sendExternalRequest = useCallback(
    async (command: MpvCommand) => {
      if (
        !mpvFlagsRef.current.externalPlayer ||
        !isExternalActive(lifecycleRef.current)
      ) {
        return null;
      }
      const ready = await ensureExternalReady();
      if (!ready) return null;
      try {
        return await sendExternalRequestRaw(command);
      } catch {
        return null;
      }
    },
    [ensureExternalReady, lifecycleRef, mpvFlagsRef, sendExternalRequestRaw],
  );

  const sendExternalCommandUnchecked = useCallback(
    async (command: MpvCommand): Promise<UncheckedSendOutcome> => {
      if (!mpvFlagsRef.current.externalPlayer) return "failed";
      try {
        const result = await sendExternalCommandRaw(command);
        if (isExternalMpvResponseError(result)) {
          const cmdArr = (command as { command?: unknown[] }).command;
          const cmdKind = Array.isArray(cmdArr)
            ? `${String(cmdArr[0] ?? "")}:${String(cmdArr[1] ?? "")}`
            : "(?)";
          const errVal = (result as unknown as { error?: unknown }).error;
          // mpv_socket_missing is a known-transient state during mpv
          // lifecycle. Downgrade to debug so noisy warnings don't fire
          // when the renderer is mid-teardown.
          const isTransient =
            typeof errVal === "string" && errVal === "mpv_socket_missing";
          const logFn = isTransient
            ? subPipelineLog.debug.bind(subPipelineLog)
            : subPipelineLog.warn.bind(subPipelineLog);
          logFn(
            {
              cmdKind,
              error: errVal,
              resultKeys: Object.keys(
                result as unknown as Record<string, unknown>,
              ),
            },
            "sendUnchecked: mpv returned error",
          );
          return isTransient ? "socket-missing" : "failed";
        }
        return "ok";
      } catch (err) {
        subPipelineLog.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "sendUnchecked: threw",
        );
        return "failed";
      }
    },
    [mpvFlagsRef, sendExternalCommandRaw],
  );

  const waitForExternalPause = useCallback(
    async (expected: boolean) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        // @bugfix @regression-proof pause-for-change-idle-dead-wait
        // No live mpv (idle/stopping, or external player disabled) means no
        // pause flag will ever flip: sendExternalRequest returns null
        // instantly and the loop below would just sleep 20 × 150 ms = 3 s.
        // Re-checked every attempt so an mpv that dies mid-wait also stops
        // the poll instead of burning the remaining budget.
        if (!hasLiveExternalPlayer(lifecycleRef.current, mpvFlagsRef.current.externalPlayer)) {
          mpvLog.info(
            { expected, attempt, lifecycleKind: lifecycleRef.current.kind },
            "waitForExternalPause: no live external player — not waiting",
          );
          return false;
        }
        try {
          const paused = await getProperty(sendExternalRequest, "pause");
          if (typeof paused === "boolean" && paused === expected) {
            return true;
          }
        } catch {
          // Ignore transient IPC/socket errors while waiting for pause state.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      }
      return false;
    },
    [lifecycleRef, mpvFlagsRef, sendExternalRequest],
  );

  const ensureExternalSeek = useCallback(
    async (target: number): Promise<ExternalSeekOutcome> => {
      if (!Number.isFinite(target)) return "invalid";
      ensureExternalSeekIdRef.current += 1;
      const seekId = ensureExternalSeekIdRef.current;
      const callerStack =
        new Error().stack?.split("\n").slice(2, 9).join(" || ") ?? "?";
      lastKnownTimeRef.current = target;
      const lifecycleAtEntry = lifecycleRef.current.kind;
      mpvLog.info(
        {
          seekId,
          target,
          lifecycleKind: lifecycleAtEntry,
          callerStack,
        },
        "ensureExternalSeek: enter (with caller)",
      );
      // @bugfix @regression-proof seek-gate-phase-flip
      // PR 3.2d: gate reads `seeksAllowed(phaseRef.current)` — a single
      // predicate replacing the legacy `isReadyToRevealRef &&
      // streamLoadfileCompleteRef` AND. The deliberate locked split lives
      // in `backdropHandoff` where deriveIsReadyToReveal=true but
      // seeksAllowed=false. Equivalence pinned by
      // tests/seeks-allowed-phase-coverage.test.ts.
      //
      // @bugfix mpv-launch-loop-seek-during-launching
      // @bugfix mpv-backdrop-handoff-seek-gate
      if (!seeksAllowed(phaseRef.current)) {
        // debug, NOT warn: this fires benignly on a normal resume — the
        // resume-position seek races the backdrop→stream handoff and is
        // correctly dropped (mpv's --start positions the stream). Still
        // greppable at debug for the #1/#3 investigation; enable
        // VITE_SF_LOG_LEVEL=debug to capture it live.
        mpvLog.debug(
          {
            seekId,
            target,
            lifecycleKind: lifecycleAtEntry,
            phaseKind: phaseRef.current.kind,
            callerStack,
          },
          "[seek-gate] ensureExternalSeek: BLOCKED — seek DROPPED (stream not loaded yet — handoff in progress). Captures the early-seek-jumps-to-0 (#1) and quality-reload-restart (#3) glitches; callerStack identifies which.",
        );
        return "blocked";
      }
      // @bugfix @regression-proof start-from-dead-mpv-dropped (#2776): mpv
      // quit just before this seek. Its socket is dead but the lifecycle
      // still reads active until the exit event lands, so every attempt
      // goes unanswered; report the exit instead of a bare "exhausted" so
      // the caller can relaunch rather than lose the request.
      const playerGone = (attempt: number, phaseOfRun: string): ExternalSeekOutcome => {
        mpvLog.info(
          { seekId, target, attempt, phaseOfRun, lifecycleKind: lifecycleRef.current.kind },
          "ensureExternalSeek: mpv exited under the seek — player-gone",
        );
        return "player-gone";
      };
      let mpvAnswered = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!isExternalActive(lifecycleRef.current)) return playerGone(attempt, "retries");
        const ok = await sendExternalCommand(
          buildSeekCommand(target, "absolute", "exact"),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        const current = await getProperty(sendExternalRequest, "time-pos");
        if (ok || current !== null) mpvAnswered = true;
        mpvLog.info(
          {
            seekId,
            attempt,
            sentOk: ok,
            current: typeof current === "number" ? current : null,
            target,
            lifecycleKind: lifecycleRef.current.kind,
          },
          "ensureExternalSeek: attempt",
        );
        if (
          typeof current === "number" &&
          Math.abs(current - target) < 0.5
        ) {
          lastKnownTimeRef.current = current;
          mpvLog.info(
            { seekId, current, attempts: attempt + 1 },
            "ensureExternalSeek: settled",
          );
          return "settled";
        }
      }
      if (!mpvAnswered) {
        const graceStart = Date.now();
        while (Date.now() - graceStart < PLAYER_GONE_GRACE_MS) {
          if (!isExternalActive(lifecycleRef.current)) return playerGone(6, "grace");
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
      }
      mpvLog.warn(
        {
          seekId,
          target,
          mpvAnswered,
          lifecycleKind: lifecycleRef.current.kind,
        },
        "ensureExternalSeek: exhausted",
      );
      return "exhausted";
    },
    // Refs (lastKnownTimeRef, lifecycleRef, phaseRef) and useCallback'd
    // helpers (sendExternalCommand, sendExternalRequest) are all stable
    // across renders — the deps list is here for ESLint exhaustive-deps but
    // the callback identity stays.
    [
      lastKnownTimeRef,
      lifecycleRef,
      phaseRef,
      sendExternalCommand,
      sendExternalRequest,
    ],
  );

  const confirmExternalPlaybackReady = useCallback(async () => {
    if (
      !mpvFlagsRef.current.externalPlayer ||
      !isExternalActive(lifecycleRef.current)
    ) {
      return false;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const [tracks, timePos] = await Promise.all([
        getProperty(sendExternalRequestRaw, "track-list"),
        getProperty(sendExternalRequestRaw, "time-pos"),
      ]);
      if (Array.isArray(tracks) && tracks.length > 0) return true;
      if (
        typeof timePos === "number" &&
        Number.isFinite(timePos) &&
        timePos >= 0
      ) {
        return true;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    return false;
  }, [lifecycleRef, mpvFlagsRef, sendExternalRequestRaw]);

  return {
    sendExternalCommandRaw,
    sendExternalRequestRaw,
    ensureExternalReady,
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
  };
};
