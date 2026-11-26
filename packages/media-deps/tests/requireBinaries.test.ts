import { describe, expect, it } from "vitest";
import {
  MEDIA_BINARIES_REQUIRED_ENV,
  REAL_MEDIA_TESTS_ENV,
  mediaBinariesRequired,
  realMediaTestsRequested,
  requireMediaBinary,
} from "../src/requireBinaries";

// @bugfix @regression-proof: the binary-backed unit suites (ffmpeg, ffprobe, mpv, luajit, xvfb-run) used
// `skipIf(!available)`, so a CI image without them reported green while the suites ran nowhere (issue #273).
// With SF_REQUIRE_MEDIA_BINARIES=1 (set by the unit-test job) a missing binary must fail the file instead.
describe("requireMediaBinary @bugfix @regression-proof", () => {
  const required = { [MEDIA_BINARIES_REQUIRED_ENV]: "1" };

  it("is a no-op when the binary is there, required or not", () => {
    expect(requireMediaBinary("ffmpeg", true, required)).toBe(true);
    expect(requireMediaBinary("ffmpeg", true, {})).toBe(true);
  });

  it("lets a suite skip on a developer machine without the binary", () => {
    expect(requireMediaBinary("ffmpeg", false, {})).toBe(false);
    expect(requireMediaBinary("ffmpeg", false, { [MEDIA_BINARIES_REQUIRED_ENV]: "0" })).toBe(false);
    expect(requireMediaBinary("ffmpeg", false, { [MEDIA_BINARIES_REQUIRED_ENV]: "" })).toBe(false);
  });

  it("throws, naming the binary and the flag, when CI requires it and it is missing", () => {
    expect(() => requireMediaBinary("luajit", false, required)).toThrow(/luajit/);
    expect(() => requireMediaBinary("luajit", false, required)).toThrow(new RegExp(MEDIA_BINARIES_REQUIRED_ENV));
  });

  it("mediaBinariesRequired is true only for the exact value 1", () => {
    expect(mediaBinariesRequired(required)).toBe(true);
    expect(mediaBinariesRequired({})).toBe(false);
    expect(mediaBinariesRequired({ [MEDIA_BINARIES_REQUIRED_ENV]: "true" })).toBe(false);
  });
});

// The real-mpv OSC suites and the real-ffmpeg playback gate fail on a loaded shared runner (blank captures,
// multi-second stalls) although the code is right, so they run only in the dedicated media-real-test job.
describe("realMediaTestsRequested", () => {
  it("is true only for the exact value 1", () => {
    console.info(`[requireBinaries:real-media] flag=${REAL_MEDIA_TESTS_ENV}`);
    expect(REAL_MEDIA_TESTS_ENV).toBe("SF_REAL_MEDIA_TESTS");
    expect(realMediaTestsRequested({ [REAL_MEDIA_TESTS_ENV]: "1" })).toBe(true);
    expect(realMediaTestsRequested({})).toBe(false);
    expect(realMediaTestsRequested({ [REAL_MEDIA_TESTS_ENV]: "true" })).toBe(false);
    expect(realMediaTestsRequested({ [MEDIA_BINARIES_REQUIRED_ENV]: "1" })).toBe(false);
  });
});
