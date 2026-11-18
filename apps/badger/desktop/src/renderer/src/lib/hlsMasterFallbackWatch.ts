import {
  classifyExternalLoadSignal,
  type ExternalLoadVerdict,
} from "@space/desktop-mpv-playback";
import type { MpvExternalMessage } from "@space/mpv-protocol";

/**
 * Watches one stream load for mpv's HLS master fallback (issue #25 P8
 * residual, @bugfix @regression-proof).
 *
 * When lavf cannot open our HLS master (a rendition's init answered 500:
 * `TUNNEL_DOWNLOAD_ERROR_download_source_missing`, which the playback server
 * has already retried before giving up), mpv ends the master with
 * `end-file reason=redirect` and plays the first variant playlist alone:
 * video only, from 0:00, `start=` ignored. The load paths race this watch
 * against their ready waits and also check `current()` before reporting
 * success, so the fallback becomes a load failure (normal "playback failed"
 * message) instead of silent wrong playback.
 *
 * There is deliberately no renderer-side retry. The playback server already
 * retries each object fetch (`object.fetch.retry`), and in the confirm run
 * every fallback was a persistently missing object. Re-issuing the master
 * would only repeat the same 500.
 *
 * Only `hls_master_fallback` counts here. An `error` end-file on a direct
 * launch makes mpv exit, and the exit path owns that case. The backdrop
 * handoff classifies every end-file itself.
 */
export type HlsMasterFallbackWatch = {
  /** Resolves with the failure verdict the moment the fallback is seen. Never rejects. */
  failure: Promise<ExternalLoadVerdict & { failed: true }>;
  /** The verdict if the fallback was already seen, else null. */
  current: () => (ExternalLoadVerdict & { failed: true }) | null;
  stop: () => void;
};

type Subscribe = ((callback: (msg: MpvExternalMessage) => void) => (() => void) | void) | undefined;

export const watchHlsMasterFallback = (
  subscribe: Subscribe,
  onEndFile?: (info: { reason: string | null; fileError: string | null; verdict: ExternalLoadVerdict }) => void,
): HlsMasterFallbackWatch => {
  let seen: (ExternalLoadVerdict & { failed: true }) | null = null;
  let resolveFailure: (verdict: ExternalLoadVerdict & { failed: true }) => void = () => undefined;
  const failure = new Promise<ExternalLoadVerdict & { failed: true }>((resolve) => {
    resolveFailure = resolve;
  });
  const unsubscribe = subscribe?.((msg) => {
    if (msg.type !== "end_file") return;
    const verdict = classifyExternalLoadSignal({ kind: "end_file", reason: msg.reason, fileError: msg.fileError });
    onEndFile?.({ reason: msg.reason, fileError: msg.fileError, verdict });
    if (seen || !verdict.failed || verdict.cause !== "hls_master_fallback") return;
    seen = verdict;
    resolveFailure(verdict);
  });
  return {
    failure,
    current: () => seen,
    stop: () => {
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
};

export const HLS_MASTER_FALLBACK_ERROR = "playback_hls_master_fallback";
