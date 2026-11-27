import { defineConfig } from "vitest/config";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  // The React Compiler as in the build (electron.vite.config.ts): a value it memoizes too long only shows with it on.
  // The app's code only, as the build compiles it: a test's own components stay as written.
  plugins: [react(), babel({ presets: [reactCompilerPreset()], exclude: [/\/node_modules\//, /\/packages\/shared\//, /\/tests\//] })],
  resolve: {
    alias: [
      { find: /^bun:sqlite$/, replacement: resolve(__dirname, "tests/__mocks__/bun-sqlite.ts") },
      { find: "@space/runtime-client/jobsV2", replacement: resolve(__dirname, "../../../packages/runtime-client/src/jobsV2.ts") },
      { find: "@space/runtime-client/jobs", replacement: resolve(__dirname, "../../../packages/runtime-client/src/jobs.ts") },
      { find: "@space/runtime-client/session", replacement: resolve(__dirname, "../../../packages/runtime-client/src/session.ts") },
      { find: "@space/runtime-client/command", replacement: resolve(__dirname, "../../../packages/runtime-client/src/command.ts") },
      { find: "@space/runtime-client/events", replacement: resolve(__dirname, "../../../packages/runtime-client/src/events.ts") },
      { find: "@space/runtime-client/errors", replacement: resolve(__dirname, "../../../packages/runtime-client/src/errors.ts") },
      { find: "@space/runtime-client/ownerSecretFile", replacement: resolve(__dirname, "../../../packages/runtime-client/src/ownerSecretFile.ts") },
      { find: "@space/runtime-client/ownerSecretIpc", replacement: resolve(__dirname, "../../../packages/runtime-client/src/ownerSecretIpc.ts") },
      { find: "@space/runtime-client", replacement: resolve(__dirname, "../../../packages/runtime-client/src/index.ts") },
      // The CI-binary helpers live in media-deps; desktop declares no dependency on it (its `file:` deps make bun
      // re-resolve them as copies when the manifest changes), so the tests reach it by path.
      { find: "@space/media-deps", replacement: resolve(__dirname, "../../../packages/media-deps/src/index.ts") },
      { find: "@", replacement: resolve(__dirname, "src/renderer/src") },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // *.perf.test.ts: absolute timing budgets, run only by the non-gating perf lane (vitest.perf.config.ts).
    exclude: ["tests/**/*.integration.test.ts", "tests/**/*.perf.test.ts", "node_modules/**"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    // Electron 42+ has no postinstall: `require("electron")` downloads the
    // binary synchronously (spawnSync) when it is missing, as on CI's
    // --ignore-scripts install. Main-process modules under test import
    // "electron" (a bare path string under Node), so without this override a
    // worker blocks for the whole download and its test times out. Unit tests
    // never launch Electron; the override makes the import return a path
    // without downloading.
    env: { ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent/electron-not-used-in-unit-tests" },
    // Default 5s is too tight under parallel load — slow integration tests
    // (media-playback-controller, file-ingestion-match-pipeline, settings-page)
    // legitimately need 5-7s and were timing out on the desktop release gate.
    testTimeout: 15_000,
    // Cap workers to avoid CPU contention causing slow renders to time out.
    // (Vitest 4: poolOptions.forks.maxForks → top-level maxWorkers.)
    maxWorkers: 11,
    server: {
      deps: {
        // Force workspace packages through Vite transform so:
        // - bun:sqlite alias applies (library-db-runtime)
        // - process.env mutations in tests are visible (mpv)
        inline: ["@space/library-db-runtime", "@space/mpv"],
      },
    },
  },
});
