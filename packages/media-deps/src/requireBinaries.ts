/**
 * Unit suites that drive a real ffmpeg / ffprobe / mpv / luajit / xvfb-run skip on a machine that has
 * none of them. CI must never take that skip: the unit-test job fetches the shipped bundle
 * (`bun scripts/fetch-deps.ts --target linux-x64`) and sets this flag, after which a suite whose binary is
 * missing fails its file instead of quietly reporting green.
 */
export const MEDIA_BINARIES_REQUIRED_ENV = "SF_REQUIRE_MEDIA_BINARIES";

export const mediaBinariesRequired = (env: NodeJS.ProcessEnv = process.env): boolean => env[MEDIA_BINARIES_REQUIRED_ENV] === "1";

/**
 * Returns `available`; throws when the binary is missing and CI requires it. Call it at the top of a test
 * file, where it computes the `skipIf` condition, so the failure names the binary rather than a timeout.
 */
export const requireMediaBinary = (name: string, available: boolean, env: NodeJS.ProcessEnv = process.env): boolean => {
  if (!available && mediaBinariesRequired(env)) {
    throw new Error(
      `${name} is not available but ${MEDIA_BINARIES_REQUIRED_ENV}=1: CI must run this suite, not skip it. ` +
        `Fetch the shipped bundle (bun scripts/fetch-deps.ts --target linux-x64) and put vendor/deps/linux-x64/bin on PATH.`
    );
  }
  return available;
};

/**
 * Suites that launch a real mpv under Xvfb and read its pixels or timing (the OSC suites) or time a real ffmpeg
 * (the playback gate) need a quiet machine: on a shared runner under load mpv stalls for seconds and the captures
 * come back blank, so they fail although the code is right. They run only when this flag is `1`, which one
 * dedicated real-media CI job sets; the unit-test jobs leave it unset. Such a file calls `requireMediaBinary`
 * only when this is true, and folds it into its `skipIf` condition.
 */
export const REAL_MEDIA_TESTS_ENV = "SF_REAL_MEDIA_TESTS";

export const realMediaTestsRequested = (env: NodeJS.ProcessEnv = process.env): boolean => env[REAL_MEDIA_TESTS_ENV] === "1";
