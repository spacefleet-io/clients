/**
 * @test-id MOBILE-PLAYBACK-SIDECAR-MEMORY-001
 * @level unit
 * @bugfix @regression-proof
 * @req PLAY-TRACK-05
 *
 * Why exists: on the OnePlus 6 (256 MB Java heap) the loopback playback proxy ran out of memory loading LOTR's 29.5 MB
 * PGS subtitle sidecar after ~15 min of playback: the 128 MB plaintext LRU was full, and the sidecar load held several
 * whole-object copies at once (read buffer, Conscrypt's one-shot GCM buffer, the padded plaintext, copyOfRange).
 * logcat: `OutOfMemoryError: Failed to allocate a 29552648 byte allocation` in `MediaCrypto.decryptSegment`, the proxy
 * answered 502 and the subtitle silently stayed off. The fix streams objects above 8 MB through a disk spool (streaming
 * AES-CTR + GHASH decrypt, never a whole-object buffer), serves them from the file, and bounds the in-memory LRU by the
 * heap. iOS had the same design (one-shot CryptoKit, 128 MB cache) and gets the same fix. The Kotlin and Swift cannot
 * run in vitest, so this pins the memory contract of both proxies.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = resolve(__dirname, "../../../../packages");
// Android's proxy is its own package (mobile-media-proxy); iOS's still ships inside mobile-mpv-playback.
const KT = join(PACKAGES, "mobile-media-proxy/android/src/main/java/com/spacefleet/mediaproxy");
const SWIFT = join(PACKAGES, "mobile-media-proxy/ios/Proxy");
const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf8");

/** The body of `fun name` / `func name` up to the next top-level-ish declaration, so assertions stay local. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  console.info(`[sidecar-memory] ${signature} @${start}`);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:private |internal |override |static |public )*(?:fun|func) /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("android playback proxy keeps large sidecars out of the Java heap", () => {
  it("ChunkFetcher hands out an ObjectBody that is either in memory or spooled to disk above 8 MB", () => {
    const src = read(KT, "ChunkFetcher.kt");
    expect(src).toMatch(/fun openObject\(key: String\): ObjectBody/);
    expect(src).toMatch(/const val SPOOL_THRESHOLD_BYTES = 8L \* 1024L \* 1024L/);
    expect(src).toMatch(/class InMemory\([^)]*\) : ObjectBody\(\)/);
    expect(src).toMatch(/class Spooled\(/);
    expect(src).not.toMatch(/fun getObject\(key: String\): ByteArray/);
  });

  it("MediaCrypto decrypts a stream with AES-CTR and its own GHASH instead of one-shot GCM", () => {
    const src = read(KT, "MediaCrypto.kt");
    const stream = body(src, "fun decryptStream(masterKey: ByteArray, input: InputStream, output: OutputStream)");
    expect(stream).toContain('Cipher.getInstance("AES/CTR/NoPadding")');
    expect(stream).not.toContain("AES/GCM");
    expect(stream).toContain('AEADBadTagException("media_tag_mismatch")');
    expect(src).toMatch(/const val STREAM_PIECE_BYTES = 64 \* 1024/);
  });

  it("the plaintext spool writes through decryptStream and deletes the file on failure", () => {
    const src = read(KT, "PlaintextSpool.kt");
    const spool = body(src, "fun spool(");
    expect(spool).toContain("MediaCrypto.decryptStream(");
    expect(spool).toMatch(/delete\(\)/);
  });

  it("the tunnel client spools large bodies, caches only in-memory ones, and bounds its LRU by the heap", () => {
    const src = read(KT, "StorageTunnelClient.kt");
    expect(src).toMatch(/cacheBudgetBytes: Long = minOf\(MAX_CACHE_BYTES, Runtime\.getRuntime\(\)\.maxMemory\(\) \/ 4\)/);
    expect(body(src, "private fun evictIfNeededLocked")).toContain("cacheSize > cacheBudgetBytes");
    // openObject is the player's read; it and the cancellable prefetch share `open` (PAR-PLAY-12).
    expect(body(src, "override fun openObject(key: String): ObjectBody")).toContain("open(key, player = true)");
    const open = body(src, "private fun open(key: String, player: Boolean): ObjectBody");
    expect(open).toContain("spool?.open(key)");
    expect(src).toContain("object.tunnel_and_spool");
  });

  it("the offline fetcher spools stored objects above the threshold instead of reading them whole", () => {
    const src = read(KT, "OfflineChunkFetcher.kt");
    const open = body(src, "override fun openObject(key: String): ObjectBody");
    const iThreshold = open.indexOf("storedBytes > ChunkFetcher.SPOOL_THRESHOLD_BYTES");
    const iSpool = open.indexOf("spool.spool(key, masterKey,");
    console.info(`[sidecar-memory] offline threshold@${iThreshold} spool@${iSpool}`);
    expect(iThreshold).toBeGreaterThan(-1);
    expect(iSpool).toBeGreaterThan(iThreshold);
  });

  it("the HTTP server writes the requested slice from the body and always releases it", () => {
    const src = read(KT, "PlaybackHttpServer.kt");
    const handle = body(src, "private fun handleObject");
    expect(handle).toContain("chunkFetcher.openObject(key)");
    expect(handle).toMatch(/payload\.writeTo\(output, range\.start, sliceLen\)/);
    expect(handle).toMatch(/finally \{[\s\S]*payload\.release\(\)/);
    expect(handle).not.toContain("copyOfRange");
  });
});

describe("iOS playback proxy keeps large sidecars out of memory", () => {
  it("MediaCrypto has a streaming CTR + GHASH decrypt", () => {
    const src = read(SWIFT, "MediaCrypto.swift");
    expect(src).toContain("static func decryptStream(");
    expect(src).toContain("CCMode(kCCModeCTR)");
    expect(src).toContain("tagMismatch");
  });

  it("objects above 8 MB go to a memory-mapped spool file and skip the LRU, which is bounded by RAM", () => {
    const spool = read(SWIFT, "PlaintextSpool.swift");
    expect(spool).toMatch(/let spoolThresholdBytes = 8 \* 1024 \* 1024/);
    expect(spool).toContain(".alwaysMapped");
    const tunnel = read(SWIFT, "StorageTunnelClient.swift");
    expect(tunnel).toMatch(/cacheBudgetBytes = min\(maxCacheBytes, Int\(ProcessInfo\.processInfo\.physicalMemory \/ 32\)\)/);
    expect(tunnel).toContain("spool.open(key)");
    expect(tunnel).toMatch(/if encrypted\.count > spoolThresholdBytes \{[\s\S]*?spool\.spool\(/);
    const offline = read(SWIFT, "OfflineChunkFetcher.swift");
    expect(offline).toMatch(/storedBytes > spoolThresholdBytes \{[\s\S]*?spool\.spool\(/);
  });

  it("the HTTP server sends a no-copy slice in pieces", () => {
    const src = read(SWIFT, "PlaybackHttpServer.swift");
    expect(src).toContain("private static func sendBody(");
    expect(src).toMatch(/sendPieceBytes = 1024 \* 1024/);
  });
});
