/**
 * Decide whether an mpv signal means "the stream failed to load and mpv will
 * NOT exit on its own".
 *
 * Why this exists (issue #25, @bugfix mpv-handoff-load-failure-black-idle-window):
 * a backdrop handoff launches mpv IDLE (`--idle=yes`, no file — see
 * `planExternalMpvLaunch` in @space/mpv) and the renderer then swaps the
 * stream in with `loadfile <url> replace`. When that load fails (HTTP 404,
 * dead tunnel, unsupported codec) mpv emits `end-file reason=error` and drops
 * back to idle instead of exiting, so the normal "mpv exited -> window comes
 * back" path never fires. Observed live on mpv 0.41: the `loadfile` command
 * itself succeeds, then `start-file`, `end-file {reason:"error",
 * file_error:"loading failed"}`, `idle`, and `idle-active` reads `true`.
 *
 * Every stream load path calls this: the backdrop handoff, the alive-mpv
 * reload, and the direct launch. A direct launch with an `error` end-file
 * exits by itself (the exit path owns that), but a `redirect` never exits:
 * mpv keeps playing the variant it fell back to.
 *
 * `redirect` (issue #25 P8 residual, @bugfix @regression-proof): our streams
 * are always an HLS master that lavf opens as ONE demuxer (every rendition
 * muxed together, `start=` honoured). When lavf cannot open it — e.g. a
 * rendition's init section answers 500 because the object is gone
 * (`TUNNEL_DOWNLOAD_ERROR_download_source_missing`) — mpv's playlist demuxer
 * takes over, ends the master with `end-file reason=redirect` and plays the
 * first variant playlist on its own: video only, from 0:00, `start=` ignored.
 * In the confirm run every redirect (18/18/4 per shard) matched one such
 * source_missing; none was a healthy load. It is a load failure.
 */
export type ExternalLoadSignal =
  /** mpv `end-file` event. `reason` is mpv's string (eof|stop|quit|error|redirect). */
  | { kind: "end_file"; reason: string | null; fileError: string | null }
  /**
   * mpv's reply to the `loadfile ... replace` command, as the renderer got it
   * (`{ error: "success" }`, an mpv error, a transport sentinel such as
   * `{ error: "mpv_request_timeout" }`, or `null` when mpv was not ready).
   */
  | { kind: "loadfile_command"; reply: unknown }
  /** `idle-active` read back after the swap settled. `null` = unreadable. */
  | { kind: "idle_active"; value: unknown };

export type ExternalLoadFailureCause =
  | "end_file_error"
  | "hls_master_fallback"
  | "loadfile_rejected"
  | "idle_after_loadfile"
  /** The mpv process exited while a load was being settled. */
  | "process_exited"
  /** mpv is alive but answered nothing (no reply, no event, no probe reply) within the load deadline. */
  | "mpv_unresponsive";

export type ExternalLoadVerdict =
  | { failed: false; why: string; unconfirmed?: true }
  | { failed: true; cause: ExternalLoadFailureCause; detail: string };

export const classifyExternalLoadSignal = (signal: ExternalLoadSignal): ExternalLoadVerdict => {
  switch (signal.kind) {
    case "end_file":
      if (signal.reason === "error") {
        return {
          failed: true,
          cause: "end_file_error",
          detail: `end-file reason=error file_error=${signal.fileError ?? "unknown"}`,
        };
      }
      if (signal.reason === "redirect") {
        return {
          failed: true,
          cause: "hls_master_fallback",
          detail:
            "end-file reason=redirect: lavf could not open the HLS master (a rendition's playlist/init failed) and mpv fell back to playing one variant playlist alone (no audio, start ignored)",
        };
      }
      return { failed: false, why: `end-file reason=${signal.reason ?? "unknown"} is not a load failure` };
    case "loadfile_command": {
      const error =
        signal.reply && typeof signal.reply === "object" && "error" in signal.reply ? signal.reply.error : undefined;
      if (error === "success") return { failed: false, why: "loadfile command accepted" };
      // The IPC reply timed out. mpv may still run the command: on a loaded
      // PC the reply routinely lands after the 1 s request budget (issue #25
      // P17: every failed handoff in the confirmation run had swapMs >= 1000,
      // and mpv logged the `loadfile` after the app had already quit it).
      if (error === "mpv_request_timeout") {
        return {
          failed: false,
          unconfirmed: true,
          why: `loadfile reply unknown (${error}); waiting for file-loaded / end-file`,
        };
      }
      return {
        failed: true,
        cause: "loadfile_rejected",
        detail: `loadfile command rejected or mpv unreachable (reply=${JSON.stringify(signal.reply ?? null)})`,
      };
    }
    case "idle_active":
      if (signal.value === true) {
        return {
          failed: true,
          cause: "idle_after_loadfile",
          detail: "idle-active=true after the loadfile swap: mpv has nothing loaded",
        };
      }
      return { failed: false, why: `idle-active=${JSON.stringify(signal.value)} (not idle or unreadable)` };
  }
};

/**
 * How long the handoff waits for `file-loaded` / `end-file` after a
 * `loadfile` whose reply is unknown. Generous on purpose: a busy 4-core PC
 * took >1 s just to answer the command. Past it the handoff carries on, and
 * its post-wait `idle-active` check still catches a load that never started.
 */
export const HANDOFF_UNCONFIRMED_LOAD_DEADLINE_MS = 20_000;

/**
 * Back-off before re-sending a handoff `loadfile` whose reply did not come
 * from mpv (see `isLoadfileTransportFailure`). Two retries, ~0.5 s in total.
 */
export const HANDOFF_LOADFILE_TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [100, 400];

/**
 * A `loadfile` reply that did not come from mpv: no reply at all, or an error
 * the IPC path produced itself (socket connect / write failure, socket
 * missing, no bridge). mpv stamps every reply with the request's
 * `request_id`, so such a reply means the command never ran and is safe to
 * send again. A timeout stays "unknown" (mpv may still run it), and any reply
 * mpv itself sent is final.
 */
export const isLoadfileTransportFailure = (reply: unknown): boolean => {
  if (reply === null || typeof reply !== "object") return true;
  if ("request_id" in reply) return false;
  const error = "error" in reply ? reply.error : undefined;
  return error !== "success" && error !== "mpv_request_timeout";
};

export type HandoffLoadfileOutcome = {
  verdict: ExternalLoadVerdict;
  settledBy: "reply" | "file_loaded" | "end_file" | "deadline";
  /** Re-sends after replies that never came from mpv (absent when none). */
  transportRetries?: number;
};

/**
 * Settle the backdrop handoff's `loadfile` (issue #25 P17). Only a real
 * error reply or a failing `end-file` (`error`, or the P8 `redirect` HLS
 * master fallback) fails the load. A reply that
 * timed out is unknown: wait for mpv's `file-loaded` (success) or the
 * `end-file` failure, bounded by `deadlineMs`.
 *
 * With `resend`, a reply that never came from mpv is not a load failure: the
 * `loadfile` is sent again after each `retryDelaysMs` step, and only fails
 * once those are spent.
 *
 * @bugfix @regression-proof issue #25 NEW-handoff-teardown-race (ultimate
 * run S1 c038): the swap's reply failed 37 ms after the window hid, mpv never
 * logged the `loadfile` (its IPC accept queue was saturated on a throttled
 * CPU), and the handoff stopped mpv 49 ms after the hide: no first frame.
 *
 * `fileLoaded` and `endFileFailure` must be armed BEFORE the command is
 * sent: on a slow reply both can fire before the reply settles.
 */
export const awaitHandoffLoadfile = async (input: {
  reply: Promise<unknown>;
  resend?: () => Promise<unknown>;
  retryDelaysMs?: readonly number[];
  fileLoaded: Promise<void>;
  endFileFailure: Promise<ExternalLoadVerdict>;
  deadlineMs?: number;
}): Promise<HandoffLoadfileOutcome> => {
  const settleReply = (reply: Promise<unknown>) =>
    Promise.race([
      reply.then(
        (value) => ({ kind: "reply" as const, reply: value }),
        // A thrown transport error is as good as an error reply: rejected.
        (error: unknown) => ({
          kind: "reply" as const,
          reply: { error: error instanceof Error ? error.message : String(error) },
        }),
      ),
      input.endFileFailure.then((verdict) => ({ kind: "end_file" as const, verdict })),
    ]);
  const retryDelays = input.resend ? (input.retryDelaysMs ?? HANDOFF_LOADFILE_TRANSPORT_RETRY_DELAYS_MS) : [];
  let first = await settleReply(input.reply);
  let transportRetries = 0;
  while (
    input.resend &&
    first.kind === "reply" &&
    transportRetries < retryDelays.length &&
    isLoadfileTransportFailure(first.reply)
  ) {
    await new Promise((resolve) => setTimeout(resolve, retryDelays[transportRetries]));
    transportRetries += 1;
    first = await settleReply(input.resend());
  }
  const retried = transportRetries > 0 ? { transportRetries } : {};
  if (first.kind === "end_file") return { verdict: first.verdict, settledBy: "end_file", ...retried };
  const replyVerdict = classifyExternalLoadSignal({ kind: "loadfile_command", reply: first.reply });
  if (replyVerdict.failed || !replyVerdict.unconfirmed) return { verdict: replyVerdict, settledBy: "reply", ...retried };
  const deadlineMs = input.deadlineMs ?? HANDOFF_UNCONFIRMED_LOAD_DEADLINE_MS;
  let cancelDeadline = () => {};
  try {
    return await Promise.race([
      input.fileLoaded.then(
        (): HandoffLoadfileOutcome => ({
          verdict: { failed: false, why: `${replyVerdict.why}; mpv reported file-loaded` },
          settledBy: "file_loaded",
          ...retried,
        }),
      ),
      input.endFileFailure.then((verdict): HandoffLoadfileOutcome => ({ verdict, settledBy: "end_file", ...retried })),
      new Promise<HandoffLoadfileOutcome>((resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              verdict: {
                failed: false,
                unconfirmed: true,
                why: `${replyVerdict.why}; no file-loaded / end-file within ${deadlineMs} ms, the idle-active check decides`,
              },
              settledBy: "deadline",
              ...retried,
            }),
          deadlineMs,
        );
        cancelDeadline = () => clearTimeout(timer);
      }),
    ]);
  } finally {
    cancelDeadline();
  }
};

/**
 * Tells a `loadfile … replace`'s own `end-file` from the replaced file's.
 * The reload arms its listeners before sending, so an `end-file` of the file
 * still playing (an ABR step-down often runs because it is failing) can
 * arrive first; mpv ends the old entry before it emits the new entry's
 * `start-file`. Only `end-file`s after that `start-file`, with its entry id
 * when both carry one, judge the load (issue #25 P15).
 */
export type NewEntryEndFileFilter = {
  startFile: (playlistEntryId: number | null) => void;
  /** True when this `end-file` belongs to the newly started entry. */
  isNewEntry: (playlistEntryId: number | null) => boolean;
  state: () => { started: boolean; entryId: number | null };
};

export const createNewEntryEndFileFilter = (): NewEntryEndFileFilter => {
  let started = false;
  let entryId: number | null = null;
  return {
    startFile: (playlistEntryId) => {
      started = true;
      entryId = playlistEntryId;
    },
    isNewEntry: (playlistEntryId) =>
      started && (entryId === null || playlistEntryId === null || playlistEntryId === entryId),
    state: () => ({ started, entryId }),
  };
};

/** The reload's settle result; `probeReply` is the deadline's idle-active probe reply, when one ran. */
export type ReloadLoadfileOutcome = HandoffLoadfileOutcome & { probeReply?: unknown };

/**
 * How long an ABR / quality reload waits for `file-loaded` / `end-file`
 * after a `loadfile` whose reply timed out. mpv was already playing, so a
 * live process normally confirms well inside it (the slowest s3 IPC reply was
 * 5.4 s); past it, one `idle-active` probe tells a hung mpv from a slow one.
 */
export const RELOAD_UNCONFIRMED_LOAD_DEADLINE_MS = 10_000;

/**
 * Settle the alive-mpv reload's `loadfile` (issue #25 P15).
 *
 * @bugfix @regression-proof issue #25 P15 (ultimate s3 x018 / x042): the
 * reload treated ANY failed `loadfile` reply as "mpv is dead". On a loaded PC
 * the reply missed the 1 s request timeout, the engine threw
 * `playback_external_loadfile_failed` and closed the player ("We couldn't
 * start playback") while mpv was alive: its log shows it ran the `loadfile`
 * after the app had already sent `quit`.
 *
 * A slow reply is not a dead process. mpv is dead only when:
 * - the process exited (`processExited` resolves with a detail), or
 * - the IPC socket is gone: a reply that never came from mpv, still failing
 *   after the transport re-sends (`resend`), or
 * - mpv itself rejected the command or reported `end-file` error/redirect.
 * A timed-out reply waits for `file-loaded` / `end-file` / exit up to
 * `deadlineMs`; at the deadline one `idle-active` probe decides: a reply with
 * `idle-active=false` carries on, `true` fails (nothing loaded), and no reply
 * at all means mpv hangs, which fails too. The 1 s request timeout stays the
 * detector for that hang; it just no longer decides alone.
 *
 * `fileLoaded`, `endFileFailure` and `processExited` must be armed BEFORE the
 * command is sent.
 */
export const awaitReloadLoadfile = async (input: {
  reply: Promise<unknown>;
  resend?: () => Promise<unknown>;
  retryDelaysMs?: readonly number[];
  fileLoaded: Promise<void>;
  endFileFailure: Promise<ExternalLoadVerdict>;
  processExited: Promise<string>;
  probeIdleActive: () => Promise<unknown>;
  deadlineMs?: number;
}): Promise<ReloadLoadfileOutcome> => {
  const exitVerdict = input.processExited.then(
    (detail): ExternalLoadVerdict => ({ failed: true, cause: "process_exited", detail }),
  );
  const outcome = await awaitHandoffLoadfile({
    reply: input.reply,
    resend: input.resend,
    retryDelaysMs: input.retryDelaysMs,
    fileLoaded: input.fileLoaded,
    endFileFailure: Promise.race([input.endFileFailure, exitVerdict]),
    deadlineMs: input.deadlineMs ?? RELOAD_UNCONFIRMED_LOAD_DEADLINE_MS,
  });
  if (outcome.settledBy !== "deadline") return outcome;
  let probeReply: unknown;
  try {
    probeReply = await input.probeIdleActive();
  } catch (error) {
    probeReply = { error: error instanceof Error ? error.message : String(error) };
  }
  if (
    probeReply === null ||
    typeof probeReply !== "object" ||
    !("error" in probeReply) ||
    probeReply.error !== "success"
  ) {
    return {
      ...outcome,
      probeReply,
      verdict: {
        failed: true,
        cause: "mpv_unresponsive",
        detail: `no file-loaded / end-file within the deadline and the idle-active probe got no reply (reply=${JSON.stringify(probeReply ?? null)})`,
      },
    };
  }
  const data = "data" in probeReply ? probeReply.data : undefined;
  const idleVerdict = classifyExternalLoadSignal({ kind: "idle_active", value: data });
  const waitWhy = outcome.verdict.failed ? outcome.verdict.detail : outcome.verdict.why;
  return {
    ...outcome,
    probeReply,
    verdict: idleVerdict.failed ? idleVerdict : { failed: false, unconfirmed: true, why: `${waitWhy}; ${idleVerdict.why}` },
  };
};
