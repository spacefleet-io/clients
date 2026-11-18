import { describe, expect, it, vi } from "vitest";

// Mock electron BEFORE importing the module — externalMpv.ts top-level imports `app` from electron.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/sf-test-userdata" },
  ipcMain: { handle: vi.fn() },
}));

// Mock the @space/mpv package — externalMpv.ts imports it at module-top.
vi.mock("@space/mpv", () => ({
  buildExternalMpvArgs: () => [],
  buildExternalMpvEnv: () => ({}),
  resolveExternalMpvTarget: () => ({ bin: "/usr/bin/mpv", kind: "system", libDirs: [] }),
}));

vi.mock("@space/desktop-mpv-playback", () => ({
  isCurrentExternalMpvLaunch: () => true,
}));

// stableSubtitleCacheKey is a tiny pure function — import it directly.
import { stableSubtitleCacheKey } from "../src/main/externalMpv";

// Dump the input URLs and their computed cache keys on assertion failure.
// try/catch so a dump failure can't mask the real expect().
const dumpSubtitleCacheKeySnapshot = (label: string, urls: string[]) => {
  try {
    console.error(`=== [external-mpv-subtitle-cache-key:${label}] snapshot ===`);
    for (const url of urls) {
      let key: string;
      try {
        key = stableSubtitleCacheKey(url);
      } catch (err) {
        key = `(threw: ${err instanceof Error ? err.message : String(err)})`;
      }
      console.error(`url=${url}\n  -> key=${key}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("stableSubtitleCacheKey @bugfix @regression-proof", () => {
  // Bug: cacheSubtitle hashed the full URL `http://127.0.0.1:<port>/playback/object/<key>`
  // where <port> is randomly assigned on each runtime launch. This made every
  // subtitle re-download on every session, costing ~1 GB of pre-launch IO for
  // PGS-heavy releases (17 .sup × 30-40 MB each) and adding ~45 s to the
  // perceived playback launch time. Fix: hash only the stable
  // `/playback/object/<key>` path so the cache survives runtime restarts.

  it("returns the same key for the same object across different runtime ports (pre-fix: FAILS)", () => {
    const objectKey = "shards%2Fspacefleet-dev-gateway%2F7a1ce912-bac5-47b3-97e9-40a5943ac3ad";
    const url1 = `http://127.0.0.1:33209/playback/object/${objectKey}`;
    const url2 = `http://127.0.0.1:51842/playback/object/${objectKey}`;
    const url3 = `http://127.0.0.1:9999/playback/object/${objectKey}`;

    console.info("[external-mpv-subtitle-cache-key:port-stable] hashing same object across 3 ports");
    const k1 = stableSubtitleCacheKey(url1);
    const k2 = stableSubtitleCacheKey(url2);
    const k3 = stableSubtitleCacheKey(url3);
    console.info(`[external-mpv-subtitle-cache-key:port-stable] k1=${k1} k2=${k2} k3=${k3}`);
    if (k1 !== k2 || k2 !== k3) {
      dumpSubtitleCacheKeySnapshot("port-stable", [url1, url2, url3]);
    }
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
  });

  it("preserves the object key inside the cache key", () => {
    const objectKey = "shards%2Fdev%2F4bce9b111e4093da";
    const url = `http://127.0.0.1:12345/playback/object/${objectKey}`;
    const key = stableSubtitleCacheKey(url);
    console.info(`[external-mpv-subtitle-cache-key:preserve] key=${key} containsObjectKey=${key.includes(objectKey)}`);
    if (!key.includes(objectKey)) {
      dumpSubtitleCacheKeySnapshot("preserve", [url]);
    }
    expect(key).toContain(objectKey);
  });

  it("falls back to the full URL when the playback-object prefix is missing", () => {
    // Defensive: external/CDN URLs (not runtime-served) keep their full hash.
    const url = "https://example.com/subs/english.srt";
    const key = stableSubtitleCacheKey(url);
    console.info(`[external-mpv-subtitle-cache-key:fallback] url=${url} key=${key}`);
    if (key !== url) {
      dumpSubtitleCacheKeySnapshot("fallback", [url]);
    }
    expect(key).toBe(url);
  });

  it("differentiates between different objects on the same runtime port", () => {
    const url1 = "http://127.0.0.1:33209/playback/object/shards%2Fa";
    const url2 = "http://127.0.0.1:33209/playback/object/shards%2Fb";
    const k1 = stableSubtitleCacheKey(url1);
    const k2 = stableSubtitleCacheKey(url2);
    console.info(`[external-mpv-subtitle-cache-key:differentiate] k1=${k1} k2=${k2} differ=${k1 !== k2}`);
    if (k1 === k2) {
      dumpSubtitleCacheKeySnapshot("differentiate", [url1, url2]);
    }
    expect(k1).not.toBe(k2);
  });
});
