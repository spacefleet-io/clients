import { describe, expect, it } from "vitest";
import { MEDIA_BINARIES_REQUIRED_ENV, mediaBinariesRequired, requireMediaBinary } from "../src/requireBinaries";

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
