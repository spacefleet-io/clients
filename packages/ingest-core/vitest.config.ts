import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    // ingest-core integration tests run real ffmpeg transcodes (DASH segment
    // production, HEVC, audio-AAC). 5 s vitest default is far too tight even
    // for the smallest fixtures — bump to 60 s. Pure unit tests in this
    // package finish well under a second so this is a pure ceiling lift.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
