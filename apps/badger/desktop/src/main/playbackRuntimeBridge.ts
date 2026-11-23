import {
  badgerPlaybackPrepareStream,
  badgerPlaybackReleaseStream,
  badgerPlaybackGetSignedUrlMetrics,
  badgerPlaybackResetSignedUrlMetrics,
  badgerPlaybackRecordSignedUrlRequest,
  badgerPlaybackSetUploadPolicy,
  badgerPreviewsGetStatus,
} from "@space/runtime-contracts";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeCommandClient } from "@space/runtime-client/command";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";

type RuntimeFetch = typeof fetch;

type RuntimeLogger = {
  warn: (payload: Record<string, unknown>, message?: string) => void;
};

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:3020";

// Every runtime record command costs a publish, a ring persist and a WS fan-out
// (#25), so object fetches during playback are coalesced into one command.
const SIGNED_URL_FLUSH_INTERVAL_MS = 2_000;

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

export class PlaybackRuntimeBridge {
  private session: RuntimeSessionHandle | null = null;
  private client: ReturnType<typeof createRuntimeCommandClient> | null = null;
  private readonly runtimeBaseUrl: string;
  private readonly fetchImpl: RuntimeFetch;
  private pendingSignedUrlRequests = 0;
  private signedUrlFlushTimer: NodeJS.Timeout | null = null;
  private signedUrlFlushChain: Promise<void> = Promise.resolve();

  constructor(
    fetchImpl: RuntimeFetch = fetch,
    runtimeBaseUrl: string = normalizeBaseUrl(
      String(process.env.SF_RUNTIME_BASE_URL ?? DEFAULT_RUNTIME_BASE_URL)
    ),
    private readonly logger: RuntimeLogger | null = null
  ) {
    this.fetchImpl = fetchImpl;
    this.runtimeBaseUrl = normalizeBaseUrl(runtimeBaseUrl);
  }

  setBackendToken(token: string | null) {
    const normalized = typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
    if (!normalized) {
      // Captures the current client, so requests recorded before sign-out still reach the runtime.
      void this.flushSignedUrlRequests();
      this.session = null;
      this.client = null;
      return;
    }
    if (this.session) {
      this.session.setBackendToken(normalized);
    } else {
      this.session = createRuntimeSession({
        runtimeBaseUrl: this.runtimeBaseUrl,
        backendToken: normalized,
        apps: ["badger"],
        ownerSecret: runtimeOwnerSecretProvider,
        fetchImpl: this.fetchImpl,
      });
      this.client = createRuntimeCommandClient({
        session: this.session,
        runtimeBaseUrl: this.runtimeBaseUrl,
        fetchImpl: this.fetchImpl,
        requestIdPrefix: "desktop-badger",
      });
    }
  }

  async prepareSession(payload: Record<string, unknown>) {
    if (!this.client) return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the IPC payload is untyped here; the runtime command validates it
      const result = await this.client.sendCommand(badgerPlaybackPrepareStream, payload as any);
      const sessionId =
        typeof result?.sessionId === "string" && result.sessionId.trim().length > 0
          ? result.sessionId.trim()
          : null;
      if (!sessionId) return null;
      return { sessionId };
    } catch (error) {
      this.logger?.warn(
        {
          event: "runtime_badger_playback_prepare_failed",
          message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        },
        "runtime playback prepare mirror failed"
      );
      return null;
    }
  }

  async mirrorPrepare(payload: Record<string, unknown>) {
    await this.prepareSession(payload);
  }

  async mirrorRelease(payload: Record<string, unknown>) {
    if (!this.client) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the IPC payload is untyped here; the runtime command validates it
      await this.client.sendCommand(badgerPlaybackReleaseStream, payload as any);
    } catch (error) {
      this.logger?.warn(
        {
          event: "runtime_badger_playback_release_failed",
          message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        },
        "runtime playback release mirror failed"
      );
    }
  }

  /**
   * #25 "uploads while a video plays": hands the runtime the user's mode and a
   * playback lease. Returns false (never throws) when the runtime is not
   * reachable yet, so the caller retries on its next heartbeat.
   */
  async sendUploadPolicy(payload: { mode: "full" | "throttle" | "pause"; playbackActive: boolean; leaseMs: number }) {
    if (!this.client) return false;
    try {
      await this.client.sendCommand(badgerPlaybackSetUploadPolicy, payload);
      return true;
    } catch (error) {
      this.logger?.warn(
        {
          event: "runtime_badger_upload_policy_failed",
          message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        },
        "runtime upload policy send failed"
      );
      return false;
    }
  }

  /**
   * MPV-PREV-06: whether the runtime's preview catch-up still means to make this source format's seek-bar previews.
   * Null (never throws) when the runtime is not reachable; the player then shows the "being prepared" hint.
   */
  async getPreviewStatus(formatId: string) {
    if (!this.client) return null;
    try {
      const { state, failures, maxAttempts } = await this.client.sendCommand(badgerPreviewsGetStatus, { formatId });
      return { state, failures, maxAttempts };
    } catch (error) {
      this.logger?.warn(
        {
          event: "runtime_badger_preview_status_failed",
          formatId,
          message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        },
        "runtime preview status failed"
      );
      return null;
    }
  }

  async getSignedUrlMetrics() {
    if (!this.client) return null;
    await this.flushSignedUrlRequests();
    try {
      const result = await this.client.sendCommand(badgerPlaybackGetSignedUrlMetrics, {});
      return {
        resetAt:
          typeof result?.resetAt === "string" && result.resetAt.trim().length > 0
            ? result.resetAt
            : new Date().toISOString(),
        requests: typeof result?.requests === "number" && Number.isFinite(result.requests) ? result.requests : 0,
      };
    } catch (error) {
      this.logger?.warn(
        {
          event: "runtime_badger_playback_metrics_get_failed",
          message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        },
        "runtime playback metrics get failed"
      );
      return null;
    }
  }

  async resetSignedUrlMetrics() {
    if (!this.client) return null;
    await this.flushSignedUrlRequests();
    try {
      const result = await this.client.sendCommand(badgerPlaybackResetSignedUrlMetrics, {});
      return {
        resetAt:
          typeof result?.resetAt === "string" && result.resetAt.trim().length > 0
            ? result.resetAt
            : new Date().toISOString(),
        requests: typeof result?.requests === "number" && Number.isFinite(result.requests) ? result.requests : 0,
      };
    } catch (error) {
      this.logger?.warn(
        {
          event: "runtime_badger_playback_metrics_reset_failed",
          message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        },
        "runtime playback metrics reset failed"
      );
      return null;
    }
  }

  recordSignedUrlRequest(increment = 1) {
    if (!this.client) return;
    this.pendingSignedUrlRequests += increment;
    if (this.signedUrlFlushTimer) return;
    this.signedUrlFlushTimer = setTimeout(() => {
      this.signedUrlFlushTimer = null;
      void this.flushSignedUrlRequests();
    }, SIGNED_URL_FLUSH_INTERVAL_MS);
    this.signedUrlFlushTimer.unref();
  }

  /**
   * Sends the coalesced signed-url request count in one runtime command and
   * resolves once every earlier flush has landed, so stats readers (and quit)
   * observe each recorded request.
   */
  flushSignedUrlRequests(): Promise<void> {
    this.clearSignedUrlFlushTimer();
    const increment = this.pendingSignedUrlRequests;
    this.pendingSignedUrlRequests = 0;
    const client = this.client;
    if (increment > 0 && client) {
      this.signedUrlFlushChain = this.signedUrlFlushChain.then(async () => {
        try {
          await client.sendCommand(badgerPlaybackRecordSignedUrlRequest, { increment });
        } catch (error) {
          this.logger?.warn(
            {
              event: "runtime_badger_playback_metrics_record_failed",
              increment,
              message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
            },
            "runtime playback metrics record failed"
          );
        }
      });
    }
    return this.signedUrlFlushChain;
  }

  private clearSignedUrlFlushTimer() {
    if (!this.signedUrlFlushTimer) return;
    clearTimeout(this.signedUrlFlushTimer);
    this.signedUrlFlushTimer = null;
  }
}
