/**
 * Shared `NotImplementedError` for Phase D step-handler stubs.
 *
 * The six badger ingest steps are wired into engineV2 so the lane scheduler,
 * dependency graph, and cancellation cascade can all be exercised end-to-end —
 * but the actual ffmpeg/encryption/upload work is intentionally deferred until
 * live observation against real video files (see plan §1 + §6 and the
 * 2026-05-01 handoff doc for the rationale).
 */
export class NotImplementedError extends Error {
  readonly errorCode = "step-not-implemented";
  constructor(stepKind: string) {
    super(
      `Step '${stepKind}' is not yet implemented. Phase D in-progress; see plan §1 + §6.`
    );
    this.name = "NotImplementedError";
  }
}
