import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests import the runtime entry, which opens runtime_jobs.db and the key/job/event stores in the runtime data dir at
// module scope. The default dir is the user's persistent one (Linux ~/.local/share/SpaceFleet/runtime), shared with an
// installed runtime: give every run a throwaway dir instead, whatever the shell exports.
const runtimeDataDir = mkdtempSync(join(tmpdir(), "sf-runtime-vitest-"));
process.on("exit", () => rmSync(runtimeDataDir, { recursive: true, force: true }));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // A throwaway SF_TRANSCODE_DIR for every test (job dirs, pending preview runs).
    setupFiles: ["tests/setup/transcodeDir.ts"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    env: { SPACEFLEET_RUNTIME_DATA_DIR: runtimeDataDir },
    // Several runtime tests do dynamic-import + module-init work (e.g.
    // BadgerModule) that exceeds vitest's 5 s default on a cold-cache run.
    // 30 s ceiling: real failures still surface fast; cold-init no longer
    // false-fails the suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
