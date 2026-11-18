/**
 * @test-id MOBILE-PLAYBACK-SEGMENT-PREFETCH-001
 * @level unit
 *
 * Why exists: libmpv's HLS demuxer reads segments serially and every cold read pays tunnel + decrypt back to back, which
 * made a timeline seek take 2.2 s (normal) / 2.8 s (throttled) after the EXTINF locale fix. The proxy therefore
 * prefetches time-aligned segments in parallel through `SegmentPrefetcher`. The Kotlin cannot run in vitest, so this
 * pins the wiring contract: the prefetcher is created with the server, fed by every session and every object request,
 * runs on its OWN pool (it must never starve mpv's request threads), is shut down with the server, and fetchers that do
 * not cache (offline store) do not double-decrypt. Since #1418 (UX-TV-03) the warm-up starts at the session's resume
 * point (`register(session, fromSeconds)`), not at the film's start.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../../../packages/mobile-media-proxy/android/src/main/java/com/spacefleet/mediaproxy");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("playback proxy segment prefetch wiring", () => {
  const server = read("PlaybackHttpServer.kt");

  it("the server owns a dedicated prefetch pool and a SegmentPrefetcher built on it", () => {
    console.info("[playback-segment-prefetch] checking server wiring");
    expect(server).toMatch(/prefetchPool = Executors\.newFixedThreadPool\(PREFETCH_THREADS\)/);
    expect(server).toMatch(/prefetcher = SegmentPrefetcher\(chunkFetcher, prefetchPool\)/);
    expect(server).toMatch(/prefetchPool\.shutdownNow\(\)/);
  });

  it("sessions are registered, and object requests drive onRequest (before the fetch) and onServed (after the write)", () => {
    const create = server.indexOf("fun createSession");
    expect(server).toContain("fun createSession(session: HlsSession, warmFromSeconds: Double = 0.0)");
    expect(server.slice(create, create + 300)).toContain("prefetcher.register(session, warmFromSeconds)");
    const handle = server.slice(server.indexOf("private fun handleObject"));
    const iRequest = handle.indexOf("prefetcher.onRequest(key)");
    const iFetch = handle.indexOf("chunkFetcher.openObject(key)");
    const iServed = handle.indexOf("prefetcher.onServed(key)");
    console.info(`[playback-segment-prefetch] onRequest@${iRequest} openObject@${iFetch} onServed@${iServed}`);
    expect(iRequest).toBeGreaterThan(-1);
    expect(iFetch).toBeGreaterThan(iRequest);
    expect(iServed).toBeGreaterThan(iFetch);
  });

  it("ChunkFetcher exposes prefetch and the offline fetcher only forwards misses", () => {
    expect(read("ChunkFetcher.kt")).toMatch(/fun prefetch\(key: String\) \{\s*openObject\(key\)\.release\(\)\s*\}/);
    expect(read("OfflineChunkFetcher.kt")).toMatch(/override fun prefetch\(key: String\) \{\s*if \(!store\.has\(key\)\) fallback\?\.prefetch\(key\)/);
  });

  it("the prefetcher warms init + first segments, aligns siblings by timeline start, and looks ahead on the live track", () => {
    const src = read("SegmentPrefetcher.kt");
    expect(src).toContain("fun register(session: HlsSession, fromSeconds: Double = 0.0)");
    expect(src).toContain("t.indexAt(fromSeconds)");
    expect(src).toContain("fun onRequest(key: String)");
    expect(src).toContain("fun onServed(key: String)");
    expect(src).toContain("sibling.indexAt(at)");
    expect(src).toContain("prefetch.done");
  });
});
