/**
 * @test-id MOBILE-PLAYBACK-PLAYLIST-LOCALE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why exists: `PlaylistBuilder` wrote `#EXTINF:` durations with `"%.3f".format(x)`, which uses the DEFAULT locale. On a
 * French phone that yields `16,900`; ffmpeg's HLS demuxer parses EXTINF with a C `strtod`, reads `16` and drops the
 * fraction. Every segment lost up to a second, so the playlist timeline (mpv duration 13138 s) drifted from the real
 * timeline (13698 s): a timeline seek to 6853 s opened video segment 466 (real 7072 s) while audio opened segment 570
 * (6846 s), and mpv then fetched 22 audio segments one after another to catch up (3.4 s normal / 8.2 s lowend). Every
 * decimal the proxy hands to mpv or an HTTP client MUST be locale independent (`Locale.ROOT`/`Locale.US`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES = resolve(__dirname, "../../../../packages");
// The loopback proxy (playlists, HTTP server) lives in mobile-media-proxy; the player in mobile-mpv-playback.
const KOTLIN_ROOTS = ["mobile-media-proxy", "mobile-mpv-playback"].map((pkg) => join(PACKAGES, pkg, "android/src/main"));

function kotlinFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? kotlinFiles(full) : full.endsWith(".kt") ? [full] : [];
  });
}

/** Mimics ffmpeg's `strtod` on the EXTINF value: stops at the first character that is not part of a C float. */
function ffmpegParseExtinf(value: string): number {
  const m = /^[+-]?\d*\.?\d*/.exec(value);
  return Number(m?.[0] ?? "0");
}

/** The locale-sensitive formatting call shapes (`"%.3f".format(x)`, `String.format("%…", …)`) without an explicit Locale. */
const LOCALE_SENSITIVE = [/"%[^"]*[fgeEG][^"]*"\.format\((?!\s*(?:java\.util\.)?Locale)/g, /String\.format\(\s*"%[^"]*[fgeEG]/g];

describe("playback proxy decimals are locale independent", () => {
  it("@regression-proof EXTINF is written without a locale-dependent decimal separator", () => {
    const source = readFileSync(join(KOTLIN_ROOTS[0]!, "java/com/spacefleet/mediaproxy/PlaylistBuilder.kt"), "utf8");
    const extinfLines = source.split("\n").filter((l) => l.includes("#EXTINF"));
    console.info(`[playback-playlist-locale] EXTINF writers: ${JSON.stringify(extinfLines.map((l) => l.trim()))}`);
    expect(extinfLines.length).toBeGreaterThanOrEqual(2);
    for (const line of extinfLines) {
      expect(line, "EXTINF must format with an explicit Locale").toMatch(/Locale\.(ROOT|US|ENGLISH)/);
      expect(line, "EXTINF must not use the default-locale format()").not.toMatch(LOCALE_SENSITIVE[0]!);
    }
  });

  it("@regression-proof no Kotlin source formats a floating-point value with the default locale", () => {
    const offenders: string[] = [];
    for (const file of KOTLIN_ROOTS.flatMap(kotlinFiles)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (LOCALE_SENSITIVE.some((re) => new RegExp(re.source).test(line))) offenders.push(`${file.slice(PACKAGES.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    console.info(`[playback-playlist-locale] default-locale float formatting offenders: ${JSON.stringify(offenders)}`);
    expect(offenders).toEqual([]);
  });

  it("documents the failure: a comma decimal truncates every ffmpeg EXTINF to whole seconds", () => {
    const real = [16.9, 13.5, 12.1, 12.7];
    const asFrench = real.map((d) => ffmpegParseExtinf(d.toFixed(3).replace(".", ",")));
    const asRoot = real.map((d) => ffmpegParseExtinf(d.toFixed(3)));
    console.info(`[playback-playlist-locale] real=${real} parsedWithComma=${asFrench} parsedWithDot=${asRoot}`);
    expect(asFrench.reduce((a, b) => a + b, 0)).toBeLessThan(real.reduce((a, b) => a + b, 0) - 1);
    expect(asRoot).toEqual(real);
  });
});
