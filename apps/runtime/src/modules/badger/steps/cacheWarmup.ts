/**
 * Round-13 #2: post-commit storage cache warmup.
 *
 * The Round-12 forensics around source-job
 * `8fcea2da-6149-4c55-852a-6dcfbab8b5cc` showed the storage-gateway taking
 * ~2 s to serve a single 4 MB chunk on localhost right after a fresh ingest
 * commit. Decryption overhead + cold storage inode cache. That latency forced
 * the launch-stalled fallback timer to fire and auto-degrade playback to 360p
 * even though the source format had already been encoded + uploaded.
 *
 * Round-12 commit `119aa13f` extended the launch-stalled timer to 20 s as a
 * temporary mitigation. This module addresses the underlying cause:
 * immediately after the commit step succeeds, fire-and-forget a warmup pass
 * that asks the storage-gateway to HEAD the init segment + first few chunks
 * of every produced video/audio format. That:
 *
 *   1. Wakes the gateway's `fetchGatewayActorFromHeaders` auth cache, so the
 *      first real GET pays no auth cost.
 *   2. Triggers per-object stat calls on the gateway's disk, which page the inode +
 *      directory blocks into the OS cache. The first GET that follows reads
 *      the data blocks at warm-cache speed.
 *
 * Design constraints (per Round-13 #2 task spec):
 *
 *   - Fire-and-forget. Warmup failures MUST NOT fail or surface to the
 *     commit step. We log and move on.
 *   - Reuse the existing `POST /storage/head` endpoint
 *     of the storage gateway — no new
 *     storage-gateway code. That endpoint accepts a batched `keys[]` payload
 *     and runs `hasStorageObject` per key against the gateway's on-disk
 *     file store.
 *   - Concurrency cap (5) to avoid hammering the gateway during a fresh
 *     post-ingest user session that may also be initiating playback.
 *   - Touch the init segment + first 5 chunks of each format. mpv reads
 *     init+seg-1 immediately on play; later segments will be pulled by the
 *     prefetch lane once the player is up and running.
 */

import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";

/**
 * Number of leading chunks per format to warm. The init segment is always
 * included on top of this, so total warmed keys per video/audio output is
 * roughly `WARMUP_LEADING_CHUNKS + 1`.
 *
 * 5 is intentionally chosen to match the typical ABR "fast-start" window —
 * mpv pulls init + seg-1 immediately, often racing seg-2 in the same first
 * second, and the prefetch lane keeps 2-3 ahead of playhead by default.
 */
const WARMUP_LEADING_CHUNKS = 5;

/**
 * Concurrency cap for the warmup HEAD batch dispatch. The Round-13 task
 * spec calls for ~5 parallel requests; we send ONE batched HEAD payload
 * containing all keys to the gateway, which does the per-key fan-out
 * server-side. The cap below guards against future shape changes (e.g.
 * splitting into multiple per-format batches).
 */
const WARMUP_BATCH_CONCURRENCY = 5;

/**
 * Total per-attempt budget. Keep tight — the goal is to warm caches, not to
 * block the commit step's caller. The runtime ingest path is fire-and-forget
 * but downstream observers may inspect the commit-step output, and we don't
 * want straggling warmup work to keep an event loop reference alive.
 */
const WARMUP_TOTAL_TIMEOUT_MS = 10_000;

/**
 * Resolves the API base URL the same way the rest of the runtime does
 * (apps/runtime/src/modules/badger.ts:1636). Falls back to
 * `http://127.0.0.1:3000` for tests + local dev.
 */
const resolveApiBase = (): string =>
  (
    process.env.SPACEFLEET_API_BASE_URL ??
    process.env.API_BASE_URL ??
    process.env.SF_API_BASE_URL ??
    "http://127.0.0.1:3000"
  ).replace(/\/+$/, "");

/**
 * Build the leading-chunk + init key list for a `ProducedMedia`. Includes:
 *
 *   - For each video format: `initKey` + first `WARMUP_LEADING_CHUNKS`
 *     chunk keys.
 *   - For each audio track:   `initKey` + first `WARMUP_LEADING_CHUNKS`
 *     chunk keys.
 *   - Subtitle tracks: skipped. mpv loads subs lazily and they're tiny —
 *     they don't drive the launch-stalled timer the way video chunks do.
 *
 * Falsy / empty keys are filtered out — a partial encode that landed in
 * commit via the disk-fallback path may have empty `initKey` strings; we
 * just skip them.
 */
export const collectWarmupKeys = (produced: ProducedMedia): string[] => {
  const keys: string[] = [];
  for (const format of produced.videoFormats) {
    if (format.initKey) keys.push(format.initKey);
    for (const chunk of format.chunks.slice(0, WARMUP_LEADING_CHUNKS)) {
      if (chunk.key) keys.push(chunk.key);
    }
  }
  for (const audio of produced.audioTracks) {
    if (audio.initKey) keys.push(audio.initKey);
    for (const chunk of audio.chunks.slice(0, WARMUP_LEADING_CHUNKS)) {
      if (chunk.key) keys.push(chunk.key);
    }
  }
  // Dedupe while preserving order — the same shard key MAY repeat across
  // overlapping format slices in pathological cases (it shouldn't, but
  // defending against it costs nothing here).
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
};

export interface WarmStorageCacheArgs {
  produced: ProducedMedia;
  /**
   * Bearer token. Required — the gateway's `/storage/head` endpoint demands
   * an authenticated user.
   * If the caller passes empty/missing token, we no-op rather than 401.
   */
  token: string | null | undefined;
  userId: string;
  jobId: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to console-style logger. */
  log?: (line: string) => void;
}

/**
 * Fire-and-forget storage-gateway cache warmup. Returns the number of keys
 * dispatched (0 when the produced shape is empty or the token is missing).
 *
 * The Promise resolves to a small status object; **all errors are swallowed
 * inside this function**. Callers MUST NOT depend on the return value to
 * decide whether the commit succeeded — it's purely observability.
 */
export interface WarmStorageCacheResult {
  dispatched: number;
  ok: boolean;
  /** Reason for `ok=false`, or undefined on success / empty no-op. */
  reason?: string;
}

export const warmStorageCache = async (
  args: WarmStorageCacheArgs
): Promise<WarmStorageCacheResult> => {
  const { produced, token, userId, jobId, log } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const writeLog = (line: string) => {
    try {
      log?.(line);
    } catch {
      /* never let observer crash break warmup */
    }
  };

  if (!token || !token.trim()) {
    writeLog(
      `[runtime] cache-warmup skip jobId=${jobId} reason=no_token (auth not ready post-commit?)`
    );
    return { dispatched: 0, ok: true, reason: "no_token" };
  }

  const keys = collectWarmupKeys(produced);
  if (keys.length === 0) {
    writeLog(`[runtime] cache-warmup skip jobId=${jobId} reason=no_keys`);
    return { dispatched: 0, ok: true, reason: "no_keys" };
  }

  const apiBase = resolveApiBase();
  const url = `${apiBase}/storage/head`;
  const startedAt = Date.now();

  // The /storage/head endpoint already fans out HEAD-object calls server-side
  // up to 500 keys per request. We send ONE batched call rather than N
  // parallel HTTP requests — that respects the WARMUP_BATCH_CONCURRENCY cap
  // (1 outbound HTTP call here, server fans out its own per-key Promise.all).
  const _concurrency = WARMUP_BATCH_CONCURRENCY; // referenced for shape parity / future split
  void _concurrency;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), WARMUP_TOTAL_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Space-App": "badger",
        },
        body: JSON.stringify({ keys }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      writeLog(
        `[runtime] cache-warmup non-2xx jobId=${jobId} userId=${userId} keys=${keys.length} status=${response.status} elapsedMs=${elapsedMs}`
      );
      return { dispatched: keys.length, ok: false, reason: `http_${response.status}` };
    }
    writeLog(
      `[runtime] cache-warmup ok jobId=${jobId} userId=${userId} keys=${keys.length} elapsedMs=${elapsedMs}`
    );
    return { dispatched: keys.length, ok: true };
  } catch (err) {
    const reason =
      err instanceof Error
        ? err.name === "AbortError"
          ? "timeout"
          : err.message
        : "unknown";
    writeLog(
      `[runtime] cache-warmup error jobId=${jobId} userId=${userId} keys=${keys.length} reason=${reason}`
    );
    return { dispatched: keys.length, ok: false, reason };
  }
};

/**
 * Test-only constants surfaced for assertions on warmup shape.
 */
export const WARMUP_TUNABLES = Object.freeze({
  leadingChunks: WARMUP_LEADING_CHUNKS,
  batchConcurrency: WARMUP_BATCH_CONCURRENCY,
  totalTimeoutMs: WARMUP_TOTAL_TIMEOUT_MS,
});
