/**
 * Pure adaptive-backoff helper for sending sf.lua external metadata after an
 * mpv loadfile (launch / direct / reload / backdrop-swap). Extracted from
 * three duplicated inline loops in `useMpvPlaybackEngine.ts` so the retry
 * shape is defined ONCE and behavior-identical across every call site.
 *
 * THE COUPLING-B TRAP — READ BEFORE EDITING
 * ==========================================
 * This helper is intentionally agnostic about `waitForExternalTracksStable`.
 * The backdrop branch MUST `await waitForExternalTracksStable()` BEFORE
 * invoking the helper (see `@bugfix
 * mpv-backdrop-handoff-metadata-before-stream-stable`). The direct-launch
 * and reload branches MUST send metadata in PARALLEL with the tracks-stable
 * wait (because mpv accepts script-message commands the moment the IPC
 * socket is up — serializing behind tracks-stable adds 200-500 ms of dead
 * time to the start budget). If the wait sequencing moves INTO this helper,
 * the backdrop branch's bugfix silently degrades on the direct/reload paths
 * — and vice versa. Each call site keeps its own wait (or absence of it)
 * inline, exactly as today. The helper only collapses the retry/backoff
 * loop, NOT the surrounding sequencing.
 */

import type { MpvCommand } from "@space/mpv-protocol";

/**
 * Result of one metadata send attempt. Matches the return type of
 * `sendExternalMetadataUnchecked` so call sites can pass it through directly
 * without wrapping.
 *
 * - `failed > 0` means at least one mpv command in the metadata batch failed
 *   and is potentially worth retrying after a short backoff.
 * - `socketMissing === true` means the mpv socket is gone (process tore down
 *   between attempts). Retrying is futile — the helper short-circuits.
 */
export type MetadataBackoffResult = { sent?: number; failed: number; socketMissing: boolean };

export type SendMetadataWithBackoffOptions = {
  /**
   * Backoff schedule in milliseconds, applied BEFORE each attempt. The first
   * entry is the pre-delay for the FIRST send (typically 0 = no wait, send
   * immediately). Subsequent entries apply on retry after a failed attempt.
   *
   * Default `[0, 100, 300]` matches the legacy inline loops: immediate fire,
   * then 100 ms backoff, then 300 ms backoff. Replaces the pre-refactor
   * fixed 200 ms × 3 = 600 ms of dead time.
   */
  delays?: number[];
};

const DEFAULT_DELAYS: readonly number[] = [0, 100, 300];

/**
 * Run `send()` up to `delays.length` times with adaptive backoff between
 * attempts. Returns the LAST result observed.
 *
 * Loop semantics — must match the legacy inline loops byte-for-byte:
 *   1. For each attempt index `i` in `0..delays.length`:
 *      a. If `delays[i] > 0`, sleep that many milliseconds (uses the global
 *         `setTimeout`, fake-timer friendly).
 *      b. Call `send()`. Capture the result.
 *      c. If the result's socket is gone (`socketMissing === true`), STOP —
 *         retry would only generate spurious warning noise during tear-down.
 *      d. If the result has zero failures (`failed === 0`), STOP — success.
 *   2. Return the most recent result.
 *
 * Pre-extraction this loop existed in three sibling sites (backdrop-handoff,
 * direct-launch, reload). Behavior must be byte-identical at every site —
 * see `apps/badger/desktop/tests/mpv-metadata-backoff.test.ts` for the
 * pinning suite.
 *
 * The first call always happens (delays[0] = 0 by default, which is a
 * no-op sleep), so the returned result is never null/undefined as long as
 * `delays` is non-empty. The helper does NOT guard against empty `delays`
 * — that would be a programmer error at the call site, not a runtime case.
 */
export async function sendMetadataWithBackoff(
  send: () => Promise<MetadataBackoffResult>,
  options?: SendMetadataWithBackoffOptions,
): Promise<MetadataBackoffResult> {
  const delays = options?.delays ?? DEFAULT_DELAYS;
  // `lastResult!` non-null assertion is safe: we always enter the loop body
  // at least once when `delays.length > 0`, so the assignment in step (b)
  // happens before any return. The empty-delays case is treated as a
  // programmer error (see note above) and would surface as a runtime
  // assertion failure on the return statement.
  let lastResult: MetadataBackoffResult | undefined;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
    }
    lastResult = await send();
    // mpv socket is gone — retrying would only produce per-command
    // socket-missing warnings. Bail with the most recent result.
    if (lastResult.socketMissing) break;
    // All commands landed cleanly. No reason to keep retrying.
    if (lastResult.failed === 0) break;
  }
  return lastResult as MetadataBackoffResult;
}

/** Outcome of one unchecked mpv command (`sendExternalCommandUnchecked`). */
export type UncheckedSendOutcome = "ok" | "failed" | "socket-missing";

type BatchLog = {
  debug: (fields: Record<string, unknown>, message: string) => void;
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
};

export type MetadataBatchResult = { sent: number; failed: number; socketMissing: boolean };

/**
 * Send one metadata batch command by command and classify the result for
 * `sendMetadataWithBackoff`. Failures caused by mpv tearing down are logged at
 * debug (expected during stop/restart); anything else is a real mpv error and
 * logs at warn.
 *
 * "Socket missing" is decided per command, not only from the renderer
 * lifecycle: during a relaunch the lifecycle stays active while main has
 * already disposed the mpv this batch targets and answers every command with
 * `mpv_socket_missing` (run 7950 ingest-undefined-language). Retrying that
 * batch is futile, so it reports `socketMissing` and the backoff stops.
 */
export async function sendMetadataBatch(
  commands: readonly MpvCommand[],
  sendCommand: (command: MpvCommand) => Promise<UncheckedSendOutcome>,
  isSessionActive: () => boolean,
  logs: { subPipeline: BatchLog; playbackDebug: BatchLog },
): Promise<MetadataBatchResult> {
  let sent = 0;
  let failed = 0;
  let socketReportedMissing = false;
  let subtitleCommandSent = false;
  for (const command of commands) {
    const outcome = await sendCommand(command);
    const ok = outcome === "ok";
    if (command.command[1] === "sf-subtitles-json") subtitleCommandSent = ok;
    if (ok) sent++; else failed++;
    if (outcome === "socket-missing") socketReportedMissing = true;
    // The mpv socket is gone (main said so, or the session ended):
    // short-circuit the rest of the batch instead of failing per command.
    if (!ok && (socketReportedMissing || !isSessionActive())) break;
  }
  const socketMissing = failed > 0 && (socketReportedMissing || !isSessionActive());
  const total = commands.length;
  if (failed > 0) {
    // Suppress warnings when the failures are caused by mpv tearing down
    // (socket gone). This is an expected transient during stop/restart and
    // is not actionable.
    const level = socketMissing ? "debug" : "warn";
    logs.subPipeline[level]({ sent, failed, total, subtitleCommandSent }, "sendMetadata: failures");
    logs.playbackDebug[level]({ sent, failed, total }, "sendExternalMetadataUnchecked");
  } else {
    logs.subPipeline.info({ sent, subtitleCommandSent }, "sendMetadata: ok");
    logs.playbackDebug.debug({ sent }, "sendExternalMetadataUnchecked ok");
  }
  return { sent, failed, socketMissing };
}
